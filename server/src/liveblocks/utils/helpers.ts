import type {
  CommentBodyBlockElement,
  CommentBodyInlineElement,
} from '@liveblocks/node';
import type {
  CordData,
  CreateCommentData,
} from 'server/src/liveblocks/utils/index.ts';
import type { MessageNode } from '@cord-sdk/types';
import { MessageNodeType } from '@cord-sdk/types';
import type { MessageEntity } from 'server/src/entity/message/MessageEntity.ts';
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
): CreateCommentData => {
  const userId = getExternalUserId(cordData, message.sourceID);
  if (!userId) {
    logger.error('User not found', {
      messageId: message.id,
      messageSourceId: message.sourceID,
    });
    throw Error('User not found');
  }

  const { content, timestamp } = message;

  logger.error('toCreateCommentData > userId', {
    userId,
    messageId: message.id,
  });

  return {
    userId,
    createdAt: timestamp,
    body: {
      version: 1,
      content: content.map(toLiveblocksCommentContent(cordData)),
    },
  };
};
