import type {
  CommentBodyBlockElement,
  CommentBodyInlineElement,
} from '@liveblocks/node';
import type { MessageNode } from '@cord-sdk/types';
import { MessageNodeType } from '@cord-sdk/types';
import type { MessageEntity } from 'server/src/entity/message/MessageEntity.ts';
import type {
  CordData,
  CreateCommentData,
  ThreadCommentMetadata,
  ThreadCommentsMetadata,
} from 'server/src/liveblocks/utils/index.ts';
import { anonymousLogger } from 'server/src/logging/Logger.ts';

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
  cordUserId: string,
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
    return null;
  }

  return user.externalID;
};

export const toCreateCommentData = (
  message: MessageEntity,
  cordData: CordData,
): CreateCommentData | null => {
  const userId = getExternalUserId(cordData, message.sourceID);
  if (!userId) {
    logger.error('>>> ERROR: User not found', {
      messageId: message.id,
      messageSourceId: message.sourceID,
    });
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
