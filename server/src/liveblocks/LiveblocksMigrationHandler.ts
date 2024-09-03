import type { CommentData, RoomData, ThreadData } from '@liveblocks/node';

import { Liveblocks, LiveblocksError } from '@liveblocks/node';

import type { Request, Response } from 'express';
import { Op } from 'sequelize';

import type { Location } from 'common/types/index.ts';
import type {
  CordData,
  CordThreadMetadata,
  RoomWithThreads,
  ThreadCommentMetadata,
  ThreadCommentsMetadata,
  ThreadEntityFull,
} from 'server/src/liveblocks/utils/index.ts';

import {
  getCordThreadLocation,
  getExternalUserId,
  getRoomId,
  isSameLocationThread,
  logFailedMessagePush,
  paginatedCallback,
  parseThreadCommentsMetadata,
  SYSTEM_USER_ID,
  ThreadMetadataKeys,
  throttledPromises,
  toCreateCommentData,
  toThreadMetadata,
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
      logger.error(
        `>>> LIVEBLOCKS ${error.status} ERROR: ${error.message} while getting room ${room.id} threads`,
      );
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
  if (!validReactions.length && reactions.length) {
    logger.error('>>> ERROR: No valid reactions found', {
      cordMessageId: cordMessageId,
      reactionIds: reactions.map((r) => r.id),
    });
    return;
  }

  try {
    await Promise.all(
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
          logger.error(
            `>>> ERROR: Failed to get external user id for ${reaction.userID}`,
          );
          return null;
        }
      }),
    );
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
    let prefix = '>>> ERROR:';
    let errorMessage = 'Unknown error';
    const baseErrorMessage = `Failed to get existing thread ${thread.id} comment ${existingPair.liveblocksCommentId} from room ${thread.roomId}`;
    if (error instanceof LiveblocksError) {
      errorMessage = error.message;
      if (error.status !== 404) {
        prefix = `>>> LIVEBLOCKS ${error.status} ERROR:`;
      }
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }
    logger.error(`${prefix} ${baseErrorMessage}`, {
      message: errorMessage,
    });
  }

  return null;
};

const createNewComment =
  (thread: ThreadData<CordThreadMetadata>, cordData: CordData) =>
  async (message: MessageEntity): Promise<ThreadCommentMetadata | null> => {
    let createdComment: CommentData | null = null;
    try {
      const existingComment = await getExistingThreadComment(thread, message);
      if (existingComment) {
        return {
          liveblocksCommentId: existingComment.id,
          cordMessageId: message.id,
        };
      }

      const commentData = toCreateCommentData(message, cordData);
      if (!commentData) {
        logFailedMessagePush(message, cordData, thread.roomId);
        return null;
      }

      createdComment = await liveblocks.createComment({
        roomId: thread.roomId,
        threadId: thread.id,
        data: commentData,
      });
    } catch (error) {
      logFailedMessagePush(message, cordData, thread.roomId);
    }

    if (!createdComment) {
      return null;
    }

    try {
      await addReactionsToComment(cordData, message.id, createdComment);
    } catch (error) {
      logger.error(
        `>>> ERROR: Failed to add reactions to comment ${createdComment.id} from thread ${thread.id} in room ${thread.roomId}`,
      );
    }

    logger.info(
      `Comment ${createdComment.id} created in thread ${thread.id}, room ${thread.roomId}`,
    );

    return {
      liveblocksCommentId: createdComment.id,
      cordMessageId: message.id,
    };
  };

/**
 * Add new comments metadata to existing thread
 * @param thread
 * @param commentsMetadata
 */
const safeAddCommmetsMetadataToThread = async (
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
    let prefix = '>>> ERROR';
    if (error instanceof LiveblocksError) {
      prefix = `>>> LIVEBLOCKS ${status} ERROR`;
      errorMessage = error.message;
      status = error.status;
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }
    logger.error(
      `${prefix}: Failed to add comments metadata to thread ${thread.id} in room ${thread.roomId}`,
      {
        error: errorMessage,
      },
    );

    return;
  }
};

const createNewThread =
  (cordData: CordData, room: RoomWithThreads) =>
  async (cordThread: ThreadEntityFull) => {
    const { messages } = cordThread;

    let thread: ThreadData<CordThreadMetadata> | undefined;
    const commentsMetadata: ThreadCommentsMetadata = [];

    const [firstMessage, ...otherMessages] = messages;
    const threadComment = toCreateCommentData(firstMessage, cordData);
    if (!threadComment) {
      logFailedMessagePush(firstMessage, cordData, room.id);
      return { cordThreadId: cordThread.id };
    }

    try {
      thread = await liveblocks.createThread({
        roomId: room.id,
        data: {
          metadata: toThreadMetadata(cordThread),
          comment: threadComment,
        },
      });

      const [firstComment] = thread.comments;
      commentsMetadata.push({
        cordMessageId: firstMessage.id,
        liveblocksCommentId: firstComment.id,
      });

      // logger.info('Thread created', { threadId: thread.id });
      await addReactionsToComment(cordData, firstMessage.id, firstComment);
    } catch (error) {
      if (error instanceof LiveblocksError) {
        if (error.status === 409) {
          if (thread?.metadata?.cordThreadId !== cordThread.id) {
            thread = room.threads.find(
              (t) => t.metadata.cordThreadId === cordThread.id,
            );
            // if (thread) {
            //   logger.info('Reusing existing thread', {
            //     cordThreadId: cordThread.id,
            //     threadId: thread?.id,
            //   });
            // }
          }
        } else {
          logFailedMessagePush(firstMessage, cordData, room.id);
        }
      } else if (error instanceof Error) {
        logFailedMessagePush(firstMessage, cordData, room.id);
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
        // logger.info('Thread resolved', {
        //   roomId: room.id,
        //   threadId: thread.id,
        //   resolverUserId,
        // });
      } catch (error) {
        if (error instanceof LiveblocksError) {
          logger.error(
            `>>> LIVEBLOCKS ${error.status} ERROR: ${error.message}; Failed to resolve thread ${thread.id} in room ${thread.roomId}`,
          );
        }
      }
    }

    const comments = await throttledPromises(
      createNewComment(thread, cordData),
      otherMessages,
    );

    comments.forEach((c) => {
      if (c) {
        commentsMetadata.push(c);
      }
    });

    await safeAddCommmetsMetadataToThread(thread, commentsMetadata);

    const commentsCount = commentsMetadata.length;
    const messagesCount = messages.length;

    logger.info(
      `Thread ${thread.id} created in room ${room.id} with ${commentsCount} comments`,
    );

    if (commentsCount !== messagesCount) {
      const failedCount = messagesCount - commentsCount;
      logger.error(
        `>>> ERROR: ${failedCount} messages not pushed to thread ${thread.id} in room ${room.id}`,
        {
          cordThreadId: cordThread.id,
          totalMessagesToCreate: messagesCount,
        },
      );
    }

    return {
      cordThreadId: cordThread.id,
      threadId: thread.id,
      commentsMetadata,
    };
  };

const createNewThreads = async (cordData: CordData, room: RoomWithThreads) => {
  const newThreadsAtLocation = cordData.threads
    .filter(
      (thread) =>
        thread.messages.length && // has messages
        isSameLocationThread(room.metadata)(thread) && // is the same location
        !room.threads.find(
          (roomThread) => roomThread.metadata.cordThreadId === thread.id,
        ),
    )
    .sort(
      (a, b) =>
        new Date(b.createdTimestamp).getTime() -
        new Date(a.createdTimestamp).getTime(),
    );

  if (!newThreadsAtLocation.length) {
    return { newThreadsIds: [], createdThreadsIds: [] };
  }

  // create new threads
  const result = await throttledPromises(
    createNewThread(cordData, room),
    newThreadsAtLocation,
  );

  const createdThreadsIds: string[] = [];

  result.forEach((r) => {
    if (r && r.threadId) {
      createdThreadsIds.push(r.threadId);
    }
  });

  const totalCount = newThreadsAtLocation.length;
  const createdCount = createdThreadsIds.length;
  const failedCount = totalCount - createdCount;

  if (failedCount > 0) {
    logger.error(
      `>>> ERROR: ${failedCount} threads not pushed to room ${room.id}`,
      {
        totalCount,
        createdCount,
        failedCount,
      },
    );
  }

  return {
    newThreadsIds: newThreadsAtLocation.map((t) => t.id),
    createdThreadsIds,
  };
};

const addMissingCommentsToExistingThread =
  (cordData: CordData) => async (thread: ThreadData) => {
    const cordThreadId = thread.metadata.cordThreadId;
    if (!cordThreadId) {
      logger.error(
        `>>> ERROR: Missing 'cordThreadId' value in thread ${thread.id} metadata from room ${thread.roomId}`,
      );
      return;
    }

    const cordThread = cordData.threads.find((t) => t.id === cordThreadId);
    if (!cordThread) {
      logger.error(
        `>>> ERROR: Cord thread with id ${cordThreadId} not found in metadata for thread ${thread.id} in room ${thread.roomId}`,
        {},
      );
      return;
    }

    const cordMessages = cordData.messages.filter(
      (m) => m.threadID === cordThread.id,
    );

    let toCreateCount = 0;
    const newComments = await throttledPromises(async (message) => {
      const existingMessage = await getExistingThreadComment(thread, message);
      if (existingMessage) {
        return null;
      }
      toCreateCount += 1;
      return await createNewComment(thread, cordData)(message);
    }, cordMessages);

    const createdComments: ThreadCommentMetadata[] = [];
    newComments.forEach((c) => {
      if (c) {
        createdComments.push(c);
      }
    });

    await safeAddCommmetsMetadataToThread(thread, createdComments);

    const createdCount = createdComments.length;
    const failedCount = toCreateCount - createdCount;
    // logger.info(`${createdCount} comments added to thread ${thread.id}`);

    if (failedCount > 0) {
      logger.error(
        `>>> ERROR: ${failedCount}/${toCreateCount} messages not pushed to thread ${thread.id} in room ${thread.roomId}`,
      );
    }

    if (createdComments.length) {
      logger.info(
        `${createdComments.length} comments added to thread ${thread.id} in room ${thread.roomId}`,
      );
    }
  };

const processRoom = (cordData: CordData) => async (room: RoomWithThreads) => {
  logger.info(`Processing room ${room.id}...`);
  const { newThreadsIds, createdThreadsIds } = await createNewThreads(
    cordData,
    room,
  );

  if (newThreadsIds.length) {
    logger.info(
      `Created ${newThreadsIds?.length ?? 0}/${
        createdThreadsIds?.length ?? 0
      } new threads for room ${room.id}`,
    );
  }

  await throttledPromises(
    addMissingCommentsToExistingThread(cordData),
    room.threads,
  );

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
        logger.error(
          `>>> LIVEBLOCKS ${error.status} ERROR: ${error.message}; Failed to get existing rooms at page ${page} with cursor ${nextCursor}`,
        );
      }
      return {
        nextCursor: null,
      };
    }
  });

  logger.info(`Fetched ${rooms.length} existing rooms`);

  const results = await throttledPromises(toRoomWithThreads, rooms, 20);

  const existingRooms: RoomWithThreads[] = [];
  results.forEach((r) => {
    if (r) {
      existingRooms.push(r);
    }
  });

  logger.info(`Fetched threads for ${existingRooms.length}existing rooms`);

  return existingRooms;
}

const getRoomParams = (
  cordOrg: Pick<OrgEntity, 'externalID'>,
  location: Location,
): Parameters<typeof liveblocks.createRoom>[1] => ({
  defaultAccesses: [],
  groupsAccesses: {
    // allow users part of this group to write in the room
    [`client_${cordOrg.externalID}`]: ['room:write'],
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
    // logger.info(`Created new room ${room.id}`);
    return room;
  } catch (e) {
    let message = 'Failed to create room';
    let liveblocksStatus = '';
    if (e instanceof LiveblocksError) {
      liveblocksStatus = ` LIVEBLOCKS ${e.status}`;
      if (e.status === 409) {
        // room already exists, should update
        const updatedRoom = await liveblocks.updateRoom(roomId, params);
        return await toRoomWithThreads(updatedRoom);
      }
      message = e.message;
    } else if (e instanceof Error) {
      message = e.message;
    }

    logger.error(
      `>>>${liveblocksStatus} ERROR: Error creating room ${roomId} - ${message}`,
      {
        groupAccesses: JSON.stringify(params.groupsAccesses),
        metadata: JSON.stringify(params.metadata),
      },
    );

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
    // logger.info(`Updated existing room ${room.id}`);
    return room;
  } catch (error) {
    if (error instanceof LiveblocksError) {
      logger.error(
        `>>> LIVEBLOCKS ${error.status} ERROR: ${error.message}, while updating room ${roomId}`,
      );
    } else if (error instanceof Error) {
      logger.error(
        `>>> ERROR: Failed to update room ${roomId} - ${
          error.message ?? 'Unknown error'
        }`,
      );
    }
    return null;
  }
};

type RoomsMapValue = {
  location: Awaited<ReturnType<typeof getCordThreadLocation>>;
  threadIds: CordData['threads'][number]['id'][];
};

const getRoomsFromCordData = (cordData: CordData) => {
  const roomsMap = new Map<string, RoomsMapValue>();

  cordData.threads.forEach(({ id, location }) => {
    // figure out why threads from different orgs are being added to the same room
    const roomId = getRoomId(location);

    let existingRoom: RoomsMapValue | undefined;
    if (roomsMap.has(roomId)) {
      existingRoom = roomsMap.get(roomId);
    }

    const threadIds = existingRoom?.threadIds ?? [];
    if (!threadIds.includes(id)) {
      threadIds.push(id);
    }

    roomsMap.set(roomId, {
      ...existingRoom,
      location,
      threadIds: threadIds.filter(
        (threadId, index, array) => array.indexOf(threadId) === index,
      ),
    });
  });

  const rooms = Array.from(roomsMap);
  logger.info(
    `Found ${rooms.length} unique rooms from ${cordData.threads.length} threads`,
  );

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

  await throttledPromises(async ([roomId, { location, threadIds }]) => {
    const threads =
      cordData.threads.filter((t) => threadIds.includes(t.id)) ?? [];
    if (!threads.length) {
      return;
    }

    const threadsOrgIds = threads.map((t) => t.orgID).filter(Boolean) ?? [];
    if (threadsOrgIds.length > 1) {
      // TODO: figure out why this happens
      logger.warn('>>> WARN: Multiple orgs found for threads', {
        roomId,
        threadIds,
        threadsOrgIds,
      });
    }

    const [orgId] = threadsOrgIds;
    const org = cordData.orgs.find((o) => o.id === orgId);
    if (!org?.externalID) {
      // logger.error(
      //   `No org externalID found for org ${orgId} in room ${roomId}`,
      // );
      return;
    }

    const roomParams = getRoomParams(org, location);

    const existingRoom = existingRooms.find((r) => r.id === roomId);
    if (existingRoom) {
      const updated = await updateRoom(existingRoom.id, roomParams);
      if (updated) {
        updatedRooms.push(updated);
      }
    } else {
      const created = await createRoom(roomId, roomParams);
      if (created) {
        createdRooms.push(created);
      }
    }
  }, roomsToCreate);

  logger.info(`${createdRooms.length} new rooms created`);
  logger.info(`${updatedRooms.length} rooms updated`);

  return [...createdRooms, ...updatedRooms];
}

export async function getCordData() {
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

  // const orgMembers = await OrgMembersEntity.findAll({
  //   where: {
  //     orgID: {
  //       [Op.in]: orgIds,
  //     },
  //   },
  // });

  const users = await UserEntity.findAll({
    // where: {
    //   id: {
    //     [Op.in]: orgMembers.map((member) => member.userID),
    //   },
    // },
  });

  const notifications = await NotificationEntity.findAll({
    where: {
      platformApplicationID: {
        [Op.in]: applicationIds,
      },
    },
  });

  const threadEntities = await ThreadEntity.findAll({
    where: {
      orgID: {
        [Op.in]: orgs.map((org) => org.id),
      },
      // ignore resolved threads
      resolvedTimestamp: null,
      resolverUserID: null,
    },
  });

  const messages = await MessageEntity.findAll({
    where: {
      threadID: {
        [Op.in]: threadEntities.map((thread) => thread.id),
      },
    },
  });

  const threads = await Promise.all(
    threadEntities.map(async (t) => {
      const location = await getCordThreadLocation(t);
      const threadMessages = messages.filter((m) => m.threadID === t.id);
      return {
        ...t.dataValues,
        location,
        messages: threadMessages,
      };
    }),
  );

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
    users,
    threads,
    messages,
    emailNotifications,
    notifications,
  };
}

const handleRoomDeletion = async (room: RoomData) => {
  try {
    await liveblocks.deleteRoom(room.id);
    return room.id;
  } catch (error) {
    let status = '';
    let errorMessage = 'Unknown error';
    if (error instanceof LiveblocksError) {
      status = ` LIVEBLOCKS ${error.status}`;
      errorMessage = error.message;
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }

    logger.error(
      `>>>${status} ERROR: ${errorMessage} while deleting room ${room.id}`,
    );

    return null;
  }
};

async function deleteExistingRooms(existingRooms: RoomData[]) {
  logger.info(`Deleting ${existingRooms.length} existing rooms...`);
  const deletedRoomsIds: string[] = [];

  const results = await throttledPromises(handleRoomDeletion, existingRooms);

  results.forEach((r) => {
    if (r) {
      deletedRoomsIds.push(r);
    }
  });

  logger.info(`Deleted ${deletedRoomsIds.length} rooms`);

  return deletedRoomsIds;
}

async function LiveblocksMigrationHandler(req: Request, res: Response) {
  try {
    logger.info(`Migrating ${environment} data to Liveblocks...`);

    const [cordData, existingRooms] = await Promise.all([
      getCordData(),
      getLiveblocksData(),
    ]);

    // const deletedRoomsIds = await deleteExistingRooms(existingRooms);
    // res
    //   .json({
    //     existingRoomsIds: existingRooms.map((r) => r.id),
    //     deletedRoomsIds: deletedRoomsIds,
    //   })
    //   .status(200);
    // return;

    const rooms = await createOrUpdateRooms(cordData, existingRooms);

    await throttledPromises(processRoom(cordData), rooms);

    await Promise.all(rooms.map(processRoom(cordData)));

    logger.info('Migration completed');

    res.status(200).json({
      success: true,
      // cordData,
      // cordStats: {
      //   orgs: cordData.orgs.length,
      //   users: cordData.users.length,
      //   threads: cordData.threads.length,
      //   messages: cordData.messages.length,
      //   emailNotifications: cordData.emailNotifications.length,
      // },
      // roomsToCreate: getRoomsFromCordData(cordData),
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
