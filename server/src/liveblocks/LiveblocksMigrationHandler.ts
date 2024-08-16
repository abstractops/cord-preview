import type { CommentData, RoomData, ThreadData } from '@liveblocks/node';

import { Liveblocks, LiveblocksError } from '@liveblocks/node';

import type { Request, Response } from 'express';
import { Op } from 'sequelize';

import type {
  CordData,
  CordOrgMetadata,
  CordThreadMetadata,
  RoomWithThreads,
} from 'server/src/liveblocks/utils/index.ts';

import {
  paginatedCallback,
  toCreateCommentData,
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
import { PageEntity } from 'server/src/entity/page/PageEntity.ts';
import { forwardHandlerExceptionsToNext } from 'server/src/public/routes/platform/util.ts';

const logger = anonymousLogger();

const liveblocks = new Liveblocks({
  secret: process.env.LIVEBLOCKS_KEY_SECRET ?? '',
});

const environment = process.env.LIVEBLOCKS_KEY_SECRET?.includes('sk_prod_')
  ? 'production'
  : 'staging';

const LIVEBLOCKS_MIGRATION_STATS = {
  rooms: 0,
  threads: 0,
  comments: 0,
};

async function toRoomWithThreads(room: RoomData) {
  const threads = await liveblocks.getThreads({
    roomId: room.id,
  });

  return {
    ...room,
    threads: threads.data,
  } satisfies RoomWithThreads;
}

const addReactionsToComment = async (
  cordMessage: CordData['messages'][number],
  comment: CommentData,
) => {
  const reactions = await MessageReactionEntity.findAll({
    where: {
      messageID: cordMessage.id,
    },
  });

  if (!reactions.length) {
    return;
  }

  await Promise.all(
    reactions
      .filter((r) => Boolean(r.userID))
      .map((reaction) => {
        return liveblocks.addCommentReaction({
          roomId: comment.roomId,
          threadId: comment.threadId,
          commentId: comment.id,
          data: {
            emoji: reaction.unicodeReaction,
            userId: reaction.userID,
            createdAt: reaction.timestamp,
          },
        });
      }),
  );

  logger.info('Added reactions to comment', {
    cordMessageId: cordMessage.id,
    count: reactions.length,
  });
};

const createNewComment =
  (thread: ThreadData, cordData: CordData) =>
  async (message: MessageEntity) => {
    try {
      logger.info('Creating new comment...', {
        cordMessageId: message.id,
        threadId: thread.id,
      });

      const comment = await liveblocks.createComment({
        roomId: thread.roomId,
        threadId: thread.id,
        data: toCreateCommentData(message, cordData),
      });

      await addReactionsToComment(message, comment);
      logger.info('Created new comment', {
        cordMessageId: message.id,
        commentId: comment.id,
      });

      return { commentId: comment.id };
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

      return { commentId: null };
    }
  };

const getCordThreadMetadata = async (
  cordThread: ThreadEntity,
): Promise<Record<string, string>> => {
  let location = {};
  try {
    const page = await PageEntity.findOne({
      where: {
        contextHash: cordThread.pageContextHash,
        orgID: cordThread.orgID,
      },
    });

    if (page?.contextData) {
      location = {
        ...page.contextData,
      };
    }
  } catch (error) {
    let errorMessage = 'Unknown error';
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    logger.error('>>> ERROR: Failed to get cord thread metadata', {
      cordThreadId: cordThread.id,
      error: errorMessage,
    });
    return location;
  }

  const cordMetadata: CordThreadMetadata = {
    cordThreadId: cordThread.id,
    cordOrgId: cordThread.orgID,
    cordCreatedTimestamp: cordThread.createdTimestamp.toISOString(),
  };

  return {
    ...cordMetadata,
    ...location,
  };
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

    const [first, ...messages] = cordMessages;

    logger.info('Cord messages count', {
      count: cordMessages.length,
    });

    const metadata = await getCordThreadMetadata(cordThread);

    let thread: ThreadData | undefined;
    try {
      thread = await liveblocks.createThread({
        roomId: room.id,
        data: {
          metadata,
          comment: toCreateCommentData(first, cordData),
        },
      });

      logger.info('Thread created', { threadId: thread.id });
      LIVEBLOCKS_MIGRATION_STATS.comments++;

      await addReactionsToComment(first, thread.comments[0]);
    } catch (error) {
      if (error instanceof LiveblocksError) {
        if (error.status === 409) {
          logger.error('>>> ERROR: Thread already exists', {
            cordThreadId: cordThread.id,
          });
          // thread already exists
        }
      }
    }

    if (!thread) {
      logger.error('>>> ERROR: Failed to create thread', {
        cordThreadId: cordThread.id,
      });
      return { cordThreadId: cordThread.id, threadId: null };
    }

    if (cordThread.resolvedTimestamp && cordThread.resolverUserID) {
      await liveblocks.markThreadAsResolved({
        roomId: room.id,
        threadId: thread.id,
        data: {
          userId: cordThread.resolverUserID,
        },
      });
      logger.info('Thread resolved', {
        threadId: thread.id,
        resolverUserId: cordThread.resolverUserID,
      });
    }

    const comments = await Promise.all(
      messages.map(createNewComment(thread, cordData)),
    );
    LIVEBLOCKS_MIGRATION_STATS.comments += comments.filter((c) =>
      Boolean(c),
    ).length;

    logger.info('Create new thread completed', {
      cordThreadId: cordThread.id,
      threadId: thread.id,
    });

    return { cordThreadId: cordThread.id, threadId: thread.id };
  };

const processRoom = (cordData: CordData) => async (room: RoomWithThreads) => {
  logger.info('Processing room...', { roomId: room.id });

  const newThreads = cordData.threads
    .filter(
      (thread) =>
        !room.threads.some((t) => t.metadata.cordThreadId === thread.id),
    )
    .sort(
      (a, b) =>
        new Date(b.createdTimestamp).getTime() -
        new Date(a.createdTimestamp).getTime(),
    );

  logger.info('New threads count', {
    count: newThreads.length,
  });

  if (newThreads.length) {
    logger.info('Creating new threads...', {
      newThreadsIds: newThreads.map((t) => t.id),
    });

    // create new threads
    const result = await Promise.all(
      newThreads.map(createNewThreadWithComments(cordData, room)),
    );

    logger.info('New threads created', { result });
  }

  logger.info('Check existing threads for missing comments...');

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

    const createdCommentsIds = result
      .filter((r): r is Required<typeof r> => Boolean(r))
      .map((c) => c.commentId);

    let message = 'Missing comments added';

    if (createdCommentsIds.length !== cordMessages.length) {
      message += ' (some comments failed)';
    }

    logger.info(message, {
      threadId: thread.id,
      cordThreadId: cordThread.id,
      totalMessagesToCreate: cordMessages.length,
      totalCommentsCreated: createdCommentsIds.length,
    });
  }

  LIVEBLOCKS_MIGRATION_STATS.threads += newThreads.length;
  LIVEBLOCKS_MIGRATION_STATS.threads += room.threads.length;

  logger.info('Room processed', { roomId: room.id });
};

async function getExistingLiveblocksData() {
  const rooms: RoomData[] = [];

  logger.info('Fetching existing rooms...');
  await paginatedCallback(async ({ nextCursor, page }) => {
    const existingRooms = await liveblocks.getRooms({
      startingAfter: page === 0 ? undefined : nextCursor ?? undefined,
    });

    rooms.push(...existingRooms.data);

    return {
      nextCursor: existingRooms.nextCursor,
    };
  });

  const existingRooms = await Promise.all(rooms.map(toRoomWithThreads));

  logger.info('Fetched existing rooms', {
    count: existingRooms.length,
  });

  return existingRooms;
}

async function createOrUpdateRooms(
  existingRooms: RoomData[],
  cordData: CordData,
) {
  const newOrgs = cordData.orgs.filter(
    (org) => !existingRooms.some((room) => room.id === org.externalID),
  );

  logger.info('Pushing new rooms...', {
    orgsIds: newOrgs.map((o) => o.externalID),
  });

  const rooms = await Promise.all(
    newOrgs.map(async (org) => {
      const orgMetadata: CordOrgMetadata = {
        cordCreatedTimestamp: org.createdTimestamp.toISOString(),
        cordOrgId: org.id,
        cordExternalId: org.externalID,
        cordState: org.state,
      };

      const roomParams: Parameters<typeof liveblocks.createRoom>[1] = {
        defaultAccesses: [],
        groupsAccesses: {
          // allow users part of this group to write in the room
          [`client_${org.externalID}`]: ['room:write'],
          internal: ['room:write'],
        },
        metadata: orgMetadata,
      };

      const existingRoom = existingRooms.find((r) => r.id === org.externalID);
      if (existingRoom) {
        const updatedRoom = await liveblocks.updateRoom(
          org.externalID,
          roomParams,
        );
        return await toRoomWithThreads(updatedRoom);
      }

      try {
        const newRoom = await liveblocks.createRoom(org.externalID, roomParams);
        if (!newRoom) {
          throw new Error('Failed to create room');
        }

        return await toRoomWithThreads(newRoom);
      } catch (e) {
        let message = 'Failed to create room';
        if (e instanceof LiveblocksError) {
          message = e.message;
        } else if (e instanceof Error) {
          message = e.message;
        }

        logger.error('>>> ERROR: Error creating room', {
          orgId: org.id,
          externalId: org.externalID,
          message,
        });

        return null;
      }
    }),
  );

  const validRooms = rooms.filter((r): r is RoomWithThreads => !!r);

  logger.info('Rooms pushed', { roomsIds: validRooms.map((r) => r.id) });

  return validRooms;
}

async function pushDataToLiveblocks(
  cordData: CordData,
  existingRooms: RoomWithThreads[],
) {
  logger.info('Pushing data to Liveblocks...');

  // Add missing rooms to liveblocks
  const newRooms = await createOrUpdateRooms(existingRooms, cordData);

  const rooms = [...existingRooms, ...newRooms]
    .filter((room) => cordData.orgs.find((org) => org.externalID === room.id))
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

  logger.info('Handling rooms...');

  // Process all rooms threaded comments to check and push any missing data
  await Promise.all(rooms.map(processRoom(cordData)));

  LIVEBLOCKS_MIGRATION_STATS.rooms = rooms.length;
  logger.info('Rooms handled');
}

async function getCordData() {
  logger.info('Fetching Cord data...');

  const applications = await ApplicationEntity.findAll({
    where: {
      environment,
    },
  });

  const applicationIds = applications.map((app) => app.id);

  const allOrgs = await OrgEntity.findAll({
    where: {
      state: 'active',
      platformApplicationID: {
        [Op.in]: applicationIds,
      },
    },
  });

  const orgs = allOrgs.filter(
    (o) => o.externalID === '01F5E6Q1GV7K62F74JAFH6K3V9',
  );

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
    },
  });

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
    users,
    threads,
    messages,
    emailNotifications,
    notifications,
  } satisfies CordData;
}

async function LiveblocksMigrationHandler(req: Request, res: Response) {
  try {
    logger.info(`Migrating ${environment} data to Liveblocks...`);

    const cordData = await getCordData();

    // Get existing data from liveblocks
    const existingRooms = await getExistingLiveblocksData();

    await pushDataToLiveblocks(cordData, existingRooms);

    if (cordData.orgs.length !== LIVEBLOCKS_MIGRATION_STATS.rooms) {
      logger.info('Failed to migrate all rooms', {
        cordOrgs: cordData.orgs.length,
        rooms: LIVEBLOCKS_MIGRATION_STATS.rooms,
      });
    }

    if (cordData.threads.length !== LIVEBLOCKS_MIGRATION_STATS.threads) {
      logger.info('Failed to migrate all threads', {
        cordThreads: cordData.threads.length,
        threads: LIVEBLOCKS_MIGRATION_STATS.threads,
      });
    }

    if (cordData.messages.length !== LIVEBLOCKS_MIGRATION_STATS.comments) {
      logger.info('Failed to migrate all comments', {
        cordMessages: cordData.messages.length,
        comments: LIVEBLOCKS_MIGRATION_STATS.comments,
      });
    }

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
      liveblocksStats: LIVEBLOCKS_MIGRATION_STATS,
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
