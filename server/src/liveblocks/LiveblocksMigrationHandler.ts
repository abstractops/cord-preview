import type { CommentData, RoomData, ThreadData } from '@liveblocks/node';

import { Liveblocks, LiveblocksError } from '@liveblocks/node';

import type { Request, Response } from 'express';
import { Op } from 'sequelize';

import type {
  CordData,
  CordThreadMetadata,
  getCordThreadLocation,
  RoomWithThreads,
  ThreadCommentMetadata,
  ThreadCommentsMetadata,
} from 'server/src/liveblocks/utils/index.ts';
import type { Location } from 'common/types/index.ts';

import {
  getCordThreadMetadata,
  getExternalUserId,
  paginatedCallback,
  parseThreadCommentsMetadata,
  SYSTEM_USER_ID,
  ThreadMetadataKeys,
  toCreateCommentData,
  toThreadData,
} from 'server/src/liveblocks/utils/index.ts';

import { OrgEntity } from 'server/src/entity/org/OrgEntity.ts';
import { anonymousLogger } from 'server/src/logging/Logger.ts';

import { MessageEntity } from 'server/src/entity/message/MessageEntity.ts';
import { MessageReactionEntity } from 'server/src/entity/message_reaction/MessageReactionEntity.ts';
import { OrgMembersEntity } from 'server/src/entity/org_members/OrgMembersEntity.ts';
import { ThreadEntity } from 'server/src/entity/thread/ThreadEntity.ts';
import { UserEntity } from 'server/src/entity/user/UserEntity.ts';

import { ApplicationEntity } from 'server/src/entity/application/ApplicationEntity.ts';
import { EmailOutboundNotificationEntity } from 'server/src/entity/email_notification/EmailOutboundNotificationEntity.ts';
import { NotificationEntity } from 'server/src/entity/notification/NotificationEntity.ts';
import { forwardHandlerExceptionsToNext } from 'server/src/public/routes/platform/util.ts';

const logger = anonymousLogger();

const liveblocks = new Liveblocks({
  secret: process.env.LIVEBLOCKS_KEY_SECRET ?? '',
});

export type CreateThreadParams = Parameters<typeof liveblocks.createThread>[0];
export type CreateRoomParams = Parameters<typeof liveblocks.createRoom>[1];

const environment = process.env.LIVEBLOCKS_KEY_SECRET?.includes('sk_prod_')
  ? 'production'
  : 'staging';

async function toRoomWithThreads(room: RoomData) {
  try {
    const threads = await liveblocks.getThreads({
      roomId: room.id,
    });

    return {
      ...room,
      threads: threads.data,
    } satisfies RoomWithThreads;
  } catch (error) {
    if (error instanceof LiveblocksError) {
      logger.error(`>>> ERROR: Failed to get room ${room.id} threads`, {
        status: error.status,
        message: error.message,
      });
    }
    return {
      ...room,
      threads: [],
    } satisfies RoomWithThreads;
  }
}

const addReactionsToComment = async (
  cordData: CordData,
  cordMessageId: string,
  comment: CommentData,
) => {
  const reactions: MessageReactionEntity[] = [];

  try {
    const result = await MessageReactionEntity.findAll({
      where: {
        messageID: cordMessageId,
      },
    });
    reactions.push(...result);
  } catch (error) {
    logger.error('>>> ERROR: Failed to get cord message reactions', {
      cordMessageId: cordMessageId,
    });
  }

  const validReactions = reactions.filter((r) => Boolean(r.userID));
  if (!validReactions.length) {
    if (reactions.length) {
      logger.error('>>> ERROR: No valid reactions found', {
        cordMessageId: cordMessageId,
        reactionIds: reactions.map((r) => r.id),
      });
    }
    return;
  }

  try {
    const result = await Promise.all(
      validReactions.map((reaction) => {
        const userId = getExternalUserId(cordData, reaction.userID);
        if (userId) {
          return liveblocks.addCommentReaction({
            roomId: comment.roomId,
            threadId: comment.threadId,
            commentId: comment.id,
            data: {
              emoji: reaction.unicodeReaction,
              userId: userId,
              createdAt: reaction.timestamp,
            },
          });
        } else {
          logger.error('>>> ERROR: Failed to get external user id', {
            cordMessageId: cordMessageId,
            cordReactionId: reaction.id,
            cordUserId: reaction.userID,
            userId: userId,
          });
          return null;
        }
      }),
    );

    logger.info('Added reactions to comment', {
      cordMessageId: cordMessageId,
      commentId: comment.id,
      count: result.length,
    });
  } catch (error) {
    logger.error('>>> ERROR: Failed to add reactions to comment', {
      cordMessageId: cordMessageId,
      commentId: comment.id,
    });
  }
};

/**
 * Try to get existing thread comment based on the cord message id found in the thread metadata
 * @param thread
 * @param message
 * @returns
 */
const getExistingThreadComment = async (
  thread: ThreadData<CordThreadMetadata>,
  message: MessageEntity,
) => {
  const pairs = parseThreadCommentsMetadata(
    thread.metadata.messageToCommentPairs,
  );

  const existingPair = pairs.find((p) => p.cordMessageId === message.id);
  if (!existingPair?.liveblocksCommentId) {
    return null;
  }

  try {
    // check the comment actually exists on liveblocks
    return await liveblocks.getComment({
      roomId: thread.roomId,
      threadId: thread.id,
      commentId: existingPair.liveblocksCommentId,
    });
  } catch (error) {
    if (error instanceof LiveblocksError) {
      logger.error('Liveblocks comment not found', {
        cordMessageId: message.id,
        commentId: existingPair.liveblocksCommentId,
        status: error.status,
        message: error.message,
      });
    } else {
      logger.error('>>> ERROR: Failed to get existing thread comment', {
        threadId: thread.id,
        commentId: existingPair.liveblocksCommentId,
      });
    }
  }
  return null;
};

const createNewComment =
  (thread: ThreadData<CordThreadMetadata>, cordData: CordData) =>
  async (message: MessageEntity): Promise<ThreadCommentMetadata | null> => {
    try {
      const existingComment = await getExistingThreadComment(thread, message);
      if (existingComment) {
        logger.info('Comment already exists', {
          cordMessageId: message.id,
          commentId: existingComment.id,
        });

        return {
          liveblocksCommentId: existingComment.id,
          cordMessageId: message.id,
        };
      }

      const commentData = toCreateCommentData(message, cordData);
      if (!commentData) {
        logger.error('>>> ERROR: Failed to create comment data', {
          cordMessageId: message.id,
        });
        return null;
      }

      const comment = await liveblocks.createComment({
        roomId: thread.roomId,
        threadId: thread.id,
        data: commentData,
      });

      logger.info('Created new comment', {
        cordMessageId: message.id,
        commentId: comment.id,
      });

      await addReactionsToComment(cordData, message.id, comment);

      return { liveblocksCommentId: comment.id, cordMessageId: message.id };
    } catch (error) {
      let status = 0;
      let errorMessage = 'Unknown error';
      if (error instanceof LiveblocksError) {
        status = error.status;
        errorMessage = error.message;
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }
      logger.error('>>> ERROR: Failed to create comment', {
        cordMessageId: message.id,
        cordThreadId: message.threadID,
        threadId: thread.id,
        status: status,
        message: errorMessage,
      });

      return null;
    }
  };

/**
 * Add new comments metadata to existing thread
 * @param thread
 * @param commentsMetadata
 */
const addCommmetsMetadataToThread = async (
  thread: ThreadData,
  commentsMetadata: ThreadCommentsMetadata,
) => {
  try {
    const existingValue =
      thread.metadata?.[ThreadMetadataKeys.MESSAGE_TO_COMMENT_PAIRS];

    const existingPairs = parseThreadCommentsMetadata(existingValue);

    const commentsPairsMetadata: ThreadCommentsMetadata = [
      ...existingPairs.filter(
        (p) =>
          !commentsMetadata.find((m) => m.cordMessageId === p.cordMessageId),
      ),
    ].concat(commentsMetadata);

    return await liveblocks.editThreadMetadata({
      roomId: thread.roomId,
      threadId: thread.id,
      data: {
        userId: SYSTEM_USER_ID,
        metadata: {
          [ThreadMetadataKeys.MESSAGE_TO_COMMENT_PAIRS]: JSON.stringify(
            commentsPairsMetadata,
          ),
        },
        updatedAt: new Date(),
      },
    });
  } catch (error) {
    let status = 0;
    let errorMessage = 'Unknown error';
    if (error instanceof LiveblocksError) {
      errorMessage = error.message;
      status = error.status;
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }
    logger.error('>>> ERROR: Failed to add comments metadata to thread', {
      threadId: thread.id,
      error: errorMessage,
      status,
    });

    return;
  }
};

const createNewThreadWithComments =
  (cordData: CordData, room: RoomWithThreads) =>
  async (cordThread: ThreadEntity) => {
    logger.info('Creating new thread...', {
      cordThreadId: cordThread.id,
      roomId: room.id,
    });

    const cordMessages = cordData.messages
      .filter((m) => m.threadID === cordThread.id && m.sourceID)
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );

    const messagesCount = cordMessages.length;

    if (!messagesCount) {
      logger.warn(`No messages found for thread ${cordThread.id}`);
      return { cordThreadId: cordThread.id };
    }

    let thread: ThreadData<CordThreadMetadata> | undefined;
    const commentsMetadata: ThreadCommentsMetadata = [];

    const [firstMessage, ...messages] = cordMessages;
    const threadComment = toCreateCommentData(firstMessage, cordData);

    if (threadComment) {
      try {
        const threadMetadata = await getCordThreadMetadata(cordThread);
        thread = await liveblocks.createThread({
          roomId: room.id,
          data: {
            metadata: threadMetadata,
            comment: threadComment,
          },
        });

        const [firstComment] = thread.comments;
        commentsMetadata.push({
          cordMessageId: firstMessage.id,
          liveblocksCommentId: firstComment.id,
        });

        logger.info('Thread created', { threadId: thread.id });
        await addReactionsToComment(cordData, firstMessage.id, firstComment);
      } catch (error) {
        if (error instanceof LiveblocksError) {
          if (error.status === 409) {
            // This should not happen, but if it does, reuse the thread data
            logger.error('>>> ERROR: Thread already exists', {
              cordThreadId: cordThread.id,
            });
            if (thread?.metadata?.cordThreadId !== cordThread.id) {
              thread = room.threads.find(
                (t) => t.metadata.cordThreadId === cordThread.id,
              );
              if (thread) {
                logger.info('Reusing existing thread', {
                  cordThreadId: cordThread.id,
                  threadId: thread?.id,
                });
              }
            }
          } else {
            logger.error('>>> LIVEBLOCKS ERROR: Failed to create thread', {
              cordThreadId: cordThread.id,
              status: error.status,
              message: error.message,
            });
          }
        } else if (error instanceof Error) {
          logger.error('>>> ERROR: Failed to create thread', {
            cordThreadId: cordThread.id,
            message: error.message,
          });
        }
      }
    }

    if (!thread) {
      logger.error('>>> ERROR: No thread created', {
        cordThreadId: cordThread.id,
      });
      return { cordThreadId: cordThread.id };
    }

    const resolverUserId = getExternalUserId(
      cordData,
      cordThread.resolverUserID,
    );
    if (cordThread.resolvedTimestamp && resolverUserId) {
      try {
        await liveblocks.markThreadAsResolved({
          roomId: room.id,
          threadId: thread.id,
          data: {
            userId: resolverUserId,
          },
        });
        logger.info('Thread resolved', {
          roomId: room.id,
          threadId: thread.id,
          resolverUserId,
        });
      } catch (error) {
        if (error instanceof LiveblocksError) {
          logger.error('markThreadAsResolved failed', {
            resolverUserId,
            status: error.status,
            message: error.message,
          });
        }
      }
      logger.info('Thread resolved', {
        threadId: thread.id,
        resolverUserId: cordThread.resolverUserID,
      });
    }

    const comments = await Promise.all(
      messages.map(createNewComment(thread, cordData)),
    );

    const createdComments = comments.filter((c): c is NonNullable<typeof c> =>
      Boolean(c),
    );

    commentsMetadata.push(...createdComments);
    await addCommmetsMetadataToThread(thread, commentsMetadata);

    const commentsCount = commentsMetadata.length;

    logger.info('Create new thread completed', {
      cordThreadId: cordThread.id,
      threadId: thread.id,
      commentsCount: commentsCount,
    });

    if (commentsCount !== messagesCount) {
      const failedCount = messagesCount - commentsCount;
      logger.error(`${failedCount} messages not pushed to Liveblocks`, {
        cordThreadId: cordThread.id,
        totalMessagesToCreate: messagesCount,
      });
    }

    return {
      cordThreadId: cordThread.id,
      threadId: thread.id,
      commentsMetadata,
    };
  };

const createNewThreads = async (cordData: CordData, room: RoomWithThreads) => {
  const sortedOrgThreads = cordData.threads
    .filter((thread) => {
      const existingRoomThread = room.threads.find(
        (roomThread) => roomThread.metadata.cordThreadId === thread.id,
      );
      return !existingRoomThread;
    })
    .sort(
      (a, b) =>
        new Date(b.createdTimestamp).getTime() -
        new Date(a.createdTimestamp).getTime(),
    );

  const roomLocation = room.metadata;

  const newThreads = sortedOrgThreads.filter(({ id }) => {
    const threadLocation = cordData.threadsLocations.find(
      (t) => t.threadId === id,
    )?.location;

    if (!threadLocation) {
      return false;
    }

    const isSameLocation = Object.entries(roomLocation).every(
      ([key, value]) => threadLocation[key] === value,
    );

    if (isSameLocation) {
      logger.info(`Room ${room.id} thread found`, {
        cordThreadId: id,
        threadLocation: threadLocation.location,
      });
    }

    return isSameLocation;
  });

  if (!newThreads.length) {
    logger.info('No new threads to create');
    return { newThreadsIds: [], createdThreadsIds: [] };
  }

  let createdThreadsIds: string[] = [];

  // create new threads
  const result = await Promise.all(
    newThreads.map(createNewThreadWithComments(cordData, room)),
  );

  const totalCount = newThreads.length;
  logger.info(`Creating ${totalCount} new threads...`, {
    newThreadsIds: newThreads.map((t) => t.id),
  });

  const createdThreads = result.filter(
    (r): r is Required<typeof r> => !!r.threadId,
  );

  createdThreadsIds = createdThreads.map((t) => t.threadId);

  const createdCount = createdThreads.length;

  logger.info(`${createdCount} threads created`);
  if (createdCount !== totalCount) {
    const failedCount = totalCount - createdCount;
    logger.error(`>>> ERROR: ${failedCount} threads not pushed to Liveblocks`, {
      totalThreadsToCreate: totalCount,
    });
  }

  return { newThreadsIds: newThreads.map((t) => t.id), createdThreadsIds };
};

const fixExistingThreadsMissingComments = async (
  cordData: CordData,
  room: RoomWithThreads,
) => {
  // check existing threads for missing comments
  for (const thread of room.threads) {
    if (!thread.metadata.cordThreadId) {
      continue;
    }

    const cordThread = cordData.threads.find(
      (t) => t.id === thread.metadata.cordThreadId,
    );

    if (!cordThread) {
      logger.error('>>> ERROR: Cord thread not found', {
        threadId: thread.id,
        cordThreadId: thread.metadata.cordThreadId,
      });
      continue;
    }

    const cordMessages = cordData.messages.filter(
      (m) => m.threadID === cordThread.id,
    );

    const result = await Promise.all(
      cordMessages.map(createNewComment(thread, cordData)),
    );

    const createdComments = result.filter((r): r is NonNullable<typeof r> =>
      Boolean(r),
    );

    await addCommmetsMetadataToThread(thread, createdComments);

    const createdCount = createdComments.length;
    if (!createdCount) {
      continue;
    }

    const toCreateCount = cordMessages.length;
    logger.info(`${createdCount} comments added to thread ${thread.id}`);

    if (createdCount !== toCreateCount) {
      const failedCount = toCreateCount - createdCount;
      logger.error(
        `>>> ERROR: ${failedCount} messages not pushed to Liveblocks`,
        {
          cordThreadId: cordThread.id,
          totalMessagesToCreate: toCreateCount,
        },
      );
    }
  }
};

const processRoom = (cordData: CordData) => async (room: RoomWithThreads) => {
  logger.info(`Processing room ${room.id}...`);
  const { newThreadsIds, createdThreadsIds } = await createNewThreads(
    cordData,
    room,
  );

  logger.info(
    `Created ${newThreadsIds?.length ?? 0}/${
      createdThreadsIds?.length ?? 0
    } new threads for room ${room.id}`,
  );

  await fixExistingThreadsMissingComments(cordData, room);

  logger.info(`Room ${room.id} processed`, { roomId: room.id });

  return true;
};

async function getLiveblocksData() {
  const rooms: RoomData[] = [];

  logger.info('Fetching existing rooms...');
  await paginatedCallback(async ({ nextCursor, page }) => {
    try {
      const existingRooms = await liveblocks.getRooms({
        startingAfter: page === 0 ? undefined : nextCursor ?? undefined,
      });
      rooms.push(...existingRooms.data);
      return {
        nextCursor: existingRooms.nextCursor,
      };
    } catch (error) {
      if (error instanceof LiveblocksError) {
        logger.error('>>> LIVEBLOCKS ERROR: Failed to get existing rooms', {
          page,
          nextCursor,
          error: error.message,
          status: error.status,
        });
      }
      return {
        nextCursor: null,
      };
    }
  });

  const existingRooms = await Promise.all(rooms.map(toRoomWithThreads));

  logger.info(`Fetched a total of ${existingRooms.length} existing rooms`);

  return existingRooms;
}

const getRoomParams = (
  cordOrg: Pick<OrgEntity, 'id'>,
  location: Location,
): Parameters<typeof liveblocks.createRoom>[1] => ({
  defaultAccesses: [],
  groupsAccesses: {
    // allow users part of this group to write in the room
    [`client_${cordOrg.id}`]: ['room:write'],
    internal: ['room:write'],
  },
  metadata: Object.entries(location).reduce<CreateRoomParams['metadata']>(
    (metadata, entry) => {
      if (!metadata) {
        metadata = {};
      }

      const [key, value] = entry;
      metadata[key] = value.toString();

      return metadata;
    },
    {},
  ),
});

const createRoom = async (
  roomId: string,
  params: ReturnType<typeof getRoomParams>,
) => {
  try {
    const newRoom = await liveblocks.createRoom(roomId, params);
    if (!newRoom) {
      throw new Error('Failed to create room');
    }

    const room = await toRoomWithThreads(newRoom);
    logger.info(`Created new room ${room.id}`);
    return room;
  } catch (e) {
    let message = 'Failed to create room';
    let status = -1;
    if (e instanceof LiveblocksError) {
      status = e.status;
      if (e.status === 409) {
        // room already exists, should update
        const updatedRoom = await liveblocks.updateRoom(roomId, params);
        return await toRoomWithThreads(updatedRoom);
      }
      message = e.message;
    } else if (e instanceof Error) {
      message = e.message;
    }

    logger.error(`>>> ERROR: Error creating room ${roomId}`, {
      status,
      message: JSON.stringify(message),
      groupAccesses: JSON.stringify(params.groupsAccesses),
      metadata: JSON.stringify(params.metadata),
    });

    return null;
  }
};

const updateRoom = async (
  roomId: string,
  params: ReturnType<typeof getRoomParams>,
) => {
  try {
    const updatedRoom = await liveblocks.updateRoom(roomId, params);
    const room = await toRoomWithThreads(updatedRoom);
    logger.info(`Updated existing room ${room.id}`);
    return room;
  } catch (error) {
    if (error instanceof LiveblocksError) {
      logger.error('>>> ERROR: Failed to update room', {
        roomId,
        status: error.status,
        message: error.message,
      });
    } else if (error instanceof Error) {
      logger.error('>>> ERROR: Failed to update room', {
        roomId,
        message: error.message,
      });
    }
    return null;
  }
};

const getRoomsFromCordData = (cordData: CordData) => {
  const roomsMap = new Map<
    string,
    {
      location: Awaited<ReturnType<typeof getCordThreadLocation>>;
      threadIds: (typeof cordData)['threads'][number]['id'][];
    }
  >();

  cordData.threadsLocations.forEach(({ threadId, roomId, location }) => {
    if (!roomsMap.has(roomId)) {
      roomsMap.set(roomId, {
        location,
        threadIds: [threadId],
      });
    }

    const room = roomsMap.get(roomId);
    if (room && !room.threadIds.includes(threadId)) {
      room.threadIds.push(threadId);
    }
  });

  const rooms = Array.from(roomsMap);
  logger.info(`Found ${rooms.length} rooms based on Cord threads locations`);

  return rooms;
};

async function createOrUpdateRooms(
  cordData: CordData,
  existingRooms: RoomData[],
) {
  const roomsToCreate = getRoomsFromCordData(cordData);

  logger.info(`Pushing ${roomsToCreate.length} new rooms...`);

  const createdRooms: RoomWithThreads[] = [];
  const updatedRooms: RoomWithThreads[] = [];

  await Promise.all(
    roomsToCreate.map(async ([roomId, { location, threadIds }]) => {
      const threads =
        cordData.threads.filter((t) => threadIds.includes(t.id)) ?? [];
      const threadsOrgIds = threads.map((t) => t.orgID).filter(Boolean) ?? [];

      if (threadsOrgIds.length > 1) {
        logger.warn('>>> WARN: Multiple orgs found for threads', {
          roomId,
          threadIds,
          threadsOrgIds,
        });
      }

      const [orgId] = threadsOrgIds;
      const org = cordData.orgs.find((o) => o.id === orgId);
      if (!org?.externalID) {
        logger.error('Not externalID found', { roomId, threadIds, orgId });
        return;
      }

      const roomParams = getRoomParams(org, location);

      const existingRoom = existingRooms.find((r) => r.id === roomId);
      if (existingRoom) {
        const updated = await updateRoom(existingRoom.id, roomParams);
        if (updated) {
          updatedRooms.push(updated);
        }
      }

      const created = await createRoom(roomId, roomParams);
      if (created) {
        createdRooms.push(created);
      }
    }),
  );

  logger.info(`${createdRooms.length} new rooms created`);
  logger.info(`${updatedRooms.length} rooms updated`);

  return [...createdRooms, ...updatedRooms];
}

async function getCordData() {
  logger.info('Fetching Cord data...');

  const applications = await ApplicationEntity.findAll({
    where: {
      environment,
    },
  });

  const applicationIds = applications.map((app) => app.id);

  const orgs = await OrgEntity.findAll({
    where: {
      state: 'active',
      platformApplicationID: {
        [Op.in]: applicationIds,
      },
      // externalID: orgExternalId,
    },
  });

  const orgIds = orgs.map((org) => org.id);

  const orgMembers = await OrgMembersEntity.findAll({
    where: {
      orgID: {
        [Op.in]: orgIds,
      },
    },
  });

  const users = await UserEntity.findAll({
    where: {
      id: {
        [Op.in]: orgMembers.map((member) => member.userID),
      },
    },
  });

  const usersWithOrg = users.map((u) => {
    const userOrgMembers = orgMembers.filter((m) => m.userID === u.id);
    const userOrgs = orgs.filter((o) =>
      userOrgMembers.find((om) => om.orgID === o.id),
    );

    if (!userOrgs?.length) {
      throw Error(`Org not found for user ${u.id}`);
    }

    return u;
  });

  const notifications = await NotificationEntity.findAll({
    where: {
      platformApplicationID: {
        [Op.in]: applicationIds,
      },
    },
  });

  const threads = await ThreadEntity.findAll({
    where: {
      orgID: {
        [Op.in]: orgs.map((org) => org.id),
      },
      // ignore resolved threads
      resolvedTimestamp: null,
      resolverUserID: null,
    },
  });

  const threadsLocations = await Promise.all(threads.map(toThreadData));

  const messages = await MessageEntity.findAll({
    where: {
      threadID: {
        [Op.in]: threads.map((thread) => thread.id),
      },
    },
  });

  const emailNotifications = await EmailOutboundNotificationEntity.findAll({
    where: {
      orgID: {
        [Op.in]: orgIds,
      },
    },
  });

  logger.info('Cord data fetched', {
    orgs: orgs.length,
    users: users.length,
    threads: threads.length,
    messages: messages.length,
    notifications: notifications.length,
  });

  return {
    orgs,
    users: usersWithOrg,
    threads,
    threadsLocations,
    messages,
    emailNotifications,
    notifications,
  } satisfies CordData;
}

async function deleteExistingRooms(existingRooms: RoomData[]) {
  logger.info(`Deleting ${existingRooms.length} existing rooms...`);
  const deletedRoomsIds = (
    await Promise.all(
      existingRooms.map(async (room) => {
        try {
          await liveblocks.deleteRoom(room.id);
          return room.id;
        } catch (error) {
          let status = -1;
          let errorMessage = 'Unknown error';
          if (error instanceof LiveblocksError) {
            status = error.status;
            errorMessage = error.message;
          } else if (error instanceof Error) {
            errorMessage = error.message;
          }

          logger.error(`>>> ERROR: Failed to delete room ${room.id}`, {
            errorMessage,
            status,
          });

          return null;
        }
      }),
    )
  ).filter(Boolean) as string[];

  deletedRoomsIds.forEach((id) => {
    const index = existingRooms.findIndex((r) => r.id === id);
    if (index !== -1) {
      existingRooms.splice(index, 1);
    }
  });

  logger.info(`Deleted ${deletedRoomsIds.length} rooms`);
}

async function LiveblocksMigrationHandler(req: Request, res: Response) {
  try {
    logger.info(`Migrating ${environment} data to Liveblocks...`);

    const [cordData, existingRooms] = await Promise.all([
      getCordData(),
      getLiveblocksData(),
    ]);

    // await deleteExistingRooms(existingRooms);

    const rooms = await createOrUpdateRooms(cordData, existingRooms);

    await Promise.all(rooms.map(processRoom(cordData)));

    logger.info('Migration completed');

    res.status(200).json({
      success: true,
      cordData,
      cordStats: {
        orgs: cordData.orgs.length,
        users: cordData.users.length,
        threads: cordData.threads.length,
        messages: cordData.messages.length,
        emailNotifications: cordData.emailNotifications.length,
      },
    });
  } catch (error) {
    let type: 'Error' | 'LiveblocksError' | 'Unknown' = 'Unknown';
    let message = 'Something went wrong';

    if (error instanceof LiveblocksError) {
      type = 'LiveblocksError';
      message = error.message;
      logger.error('>>> ERROR: LiveblocksError', {
        name: error.name,
        message: error.message,
        status: error.status,
      });
    } else if (error instanceof Error) {
      type = 'Error';
      message = error.message;
      logger.error('>>> ERROR: Error', {
        name: error.name,
        message: error.message,
      });
    }

    res.status(500).json({
      success: false,
      error: 'Migration failed',
      type,
      message,
    });
  }
}

export default forwardHandlerExceptionsToNext(LiveblocksMigrationHandler);
