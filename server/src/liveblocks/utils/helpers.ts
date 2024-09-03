import type {
  CommentBodyBlockElement,
  CommentBodyInlineElement,
  RoomData,
} from '@liveblocks/node';
import { v5 as uuid } from 'uuid';
import winston from 'winston';
import type { Location, MessageNode } from '@cord-sdk/types';
import { MessageNodeType } from '@cord-sdk/types';
import type { MessageEntity } from 'server/src/entity/message/MessageEntity.ts';
import { ROOM_ID_NAMESPACE } from 'server/src/liveblocks/utils/index.ts';
import type {
  CordData,
  CordThreadMetadata,
  CreateCommentData,
  ThreadCommentMetadata,
  ThreadCommentsMetadata,
  ThreadEntityFull,
} from 'server/src/liveblocks/utils/index.ts';
import { anonymousLogger } from 'server/src/logging/Logger.ts';
import { PageEntity } from 'server/src/entity/page/PageEntity.ts';
import type { ThreadEntity } from 'server/src/entity/thread/ThreadEntity.ts';

const logger = anonymousLogger();

/**
 * Wrapper function to handle liveblocks api method that return paginated data
 * @param callback liveblock api method
 */
export async function paginatedCallback(
  callback: (params: { page: number; nextCursor: string | null }) => Promise<{
    nextCursor: string | null;
  }>,
) {
  let nextCursor: string | null = null;
  let page = 0;
  while (page === 0 || nextCursor !== null) {
    const result = await callback({ page, nextCursor });
    nextCursor = result.nextCursor;
    page += 1;
  }
}

const toLiveblocksCommentContent =
  (cordData: CordData) =>
  (messageNode: MessageNode): CommentBodyBlockElement => {
    const children: CommentBodyInlineElement[] = [];

    if (!messageNode.type) {
      return {
        type: 'paragraph',
        children: [
          {
            text: messageNode.text,
            bold: messageNode.bold,
            code: messageNode.code,
            italic: messageNode.italic,
          },
        ],
      };
    }

    switch (messageNode.type) {
      case MessageNodeType.PARAGRAPH:
      case MessageNodeType.MENTION:
      case MessageNodeType.LINK:
      case MessageNodeType.ASSIGNEE:
        messageNode.children.forEach((child) => {
          if (!child.type) {
            children.push({
              text: child.text,
              bold: child.bold,
              italic: child.italic,
              code: child.code,
            });
          }
          if (child.type === MessageNodeType.MENTION) {
            let userId = getExternalUserId(cordData, child.user.id);
            if (!userId) {
              logger.error('User not found', { cordUserId: child.user.id });
              userId = child.user.id;
            }

            children.push({
              type: 'mention',
              id: userId,
            });
          }
          if (child.type === MessageNodeType.LINK) {
            children.push({
              type: 'link',
              url: child.url,
            });
          }
        });
        break;
    }

    return {
      type: 'paragraph',
      children,
    };
  };

export const getExternalUserId = (
  cordData: CordData,
  cordUserId?: string | null,
): string | null => {
  if (!cordUserId) {
    return null;
  }

  let user = cordData.users.find((u) => u.id === cordUserId);
  if (!user) {
    logger.info('Trying to find user from email notification');
    const emailNotification = cordData.emailNotifications.find((n) =>
      [n.id, n.userID].includes(cordUserId),
    );
    user = cordData.users.find((u) => u.id === emailNotification?.userID);
  }

  if (!user) {
    logger.error(`>>> ERROR: User ${cordUserId} not found`);
    return cordUserId;
  }

  return user.externalID ?? user.id;
};

export const toCreateCommentData = (
  message: MessageEntity,
  cordData: CordData,
): CreateCommentData | null => {
  const userId = getExternalUserId(cordData, message.sourceID);
  if (!userId) {
    return null;
  }

  const { content, timestamp } = message;

  return {
    userId,
    createdAt: timestamp,
    body: {
      version: 1,
      content: content.map(toLiveblocksCommentContent(cordData)),
    },
  };
};

export const parseThreadCommentMetadata = (
  value: unknown,
): ThreadCommentMetadata | null => {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parseThreadCommentMetadata(parsed);
    } catch (error) {
      return null;
    }
  }

  if (typeof value !== 'object') {
    return null;
  }

  if (!('cordMessageId' in value) || !('liveblocksCommentId' in value)) {
    return null;
  }

  return value as ThreadCommentMetadata;
};

/**
 * Parse thread comments metadata from expected stringified JSON format
 * @param value
 * @returns
 */
export const parseThreadCommentsMetadata = (
  value?: string | number | boolean | undefined,
): ThreadCommentsMetadata => {
  if (value === undefined || typeof value !== 'string') {
    return [];
  }

  let parsed: unknown;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      return [];
    }
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const pairs: ThreadCommentsMetadata = [];

  for (const item of parsed) {
    const pair = parseThreadCommentMetadata(item);
    if (!pair) {
      continue;
    }

    pairs.push(pair);
  }

  return pairs;
};

export const getCordThreadLocation = async (
  cordThread?: ThreadEntity,
): Promise<Location> => {
  let location: Location = {};
  if (!cordThread) {
    return location;
  }

  try {
    const page = await PageEntity.findOne({
      where: {
        contextHash: cordThread.pageContextHash,
        orgID: cordThread.orgID,
      },
    });

    if (page?.contextData) {
      location = page.contextData;
    }
  } catch (error) {
    let errorMessage = 'Unknown error';
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    logger.error('>>> ERROR: Failed to get cord thread location', {
      cordThreadId: cordThread.id,
      error: errorMessage,
    });
  }

  return location;
};

export const toThreadMetadata = (cordThread: ThreadEntityFull) => {
  const { id, orgID, createdTimestamp, location } = cordThread;

  const cordMetadata: CordThreadMetadata = {
    cordThreadId: id,
    cordOrgId: orgID,
    cordCreatedTimestamp: createdTimestamp.toISOString(),
  };

  return {
    ...cordMetadata,
    ...location,
  };
};

export const getRoomId = (location: Location): string => {
  return uuid(JSON.stringify(location), ROOM_ID_NAMESPACE);
};

export const isSameLocationThread =
  (location: Location | RoomData['metadata']) =>
  (thread: CordData['threads'][number]): boolean => {
    if (!thread?.location) {
      return false;
    }
    return Object.entries(location).every(
      ([key, value]) => thread.location[key] === value,
    );
  };

const { combine, timestamp, json } = winston.format;

const fileLogger = winston.createLogger({
  format: combine(timestamp(), json()),
  transports: [
    new winston.transports.File({
      filename: 'liveblocks-migration.log',
    }),
  ],
});

export const logFailedMessagePush = (
  message: MessageEntity,
  cordData: CordData,
  roomId: string,
  errorMessage?: string,
) => {
  const org = cordData.orgs.find((o) => o.id === message.orgID);
  const userId = getExternalUserId(cordData, message.sourceID);
  const thread = cordData.threads.find((t) => t.id === message.threadID);

  fileLogger.error(errorMessage ?? 'Failed to push message to liveblocks', {
    roomId: roomId,
    clientId: org?.externalID,
    userId: userId,
    message: JSON.stringify(message.content),
    location: JSON.stringify(thread?.location),
  });
};

async function asyncForEach<T>(
  array: T[],
  callback: (item: T, index: number, array: T[]) => Promise<void>,
) {
  for (const item of array) {
    await callback(item, array.indexOf(item), array);
  }
}

function split<T>(arr: T[], n: number): T[][] {
  const res = [];
  while (arr.length) {
    res.push(arr.splice(0, n));
  }
  return res;
}
const delayMS = (t = 200) => {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(t);
    }, t);
  });
};

/**
 * Say you want to call 'parse' on 5 values, but run a maximum of 2 at a time, with 100ms delay between each batch.   Call like:
 *
 * throttlePromises(async (values) => await parse(values), ['1','2','3','4','5'], 2, 100)
 */
export function throttledPromises<T, R>(
  asyncFunction: (item: T, index: number, array: T[]) => Promise<R>,
  items: T[],
  batchSize = 10,
  delay = 50,
): Promise<(Awaited<R> | void)[]> {
  return new Promise((resolve, reject) => {
    const output: (Awaited<R> | void)[] = [];
    const batches = split(items, batchSize);
    asyncForEach(batches, async (batch, batchNumber) => {
      const promises = batch
        .map((item, innerIndex) =>
          asyncFunction(item, batchNumber * batchSize + innerIndex, items),
        )
        .map((p) => p.catch(reject));
      const results = await Promise.all(promises);
      output.push(...results);
      if (delay) {
        await delayMS(delay);
      }
    })
      .then(() => {
        resolve(output);
      })
      .catch((e) => {
        reject(e);
      });
  });
}
