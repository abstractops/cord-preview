import type { Liveblocks, RoomData, ThreadData } from '@liveblocks/node';
import type { EmailOutboundNotificationEntity } from 'server/src/entity/email_notification/EmailOutboundNotificationEntity.ts';
import type { MessageEntity } from 'server/src/entity/message/MessageEntity.ts';
import type { NotificationEntity } from 'server/src/entity/notification/NotificationEntity.ts';
import type { OrgEntity } from 'server/src/entity/org/OrgEntity.ts';
import type { ThreadEntity } from 'server/src/entity/thread/ThreadEntity.ts';
import type { UserEntity } from 'server/src/entity/user/UserEntity.ts';
import type { ThreadMetadataKeys } from 'server/src/liveblocks/utils/index.ts';

export type CordData = {
  orgs: OrgEntity[];
  users: UserEntity[];
  threads: ThreadEntity[];
  messages: MessageEntity[];
  emailNotifications: EmailOutboundNotificationEntity[];
  notifications: NotificationEntity[];
};

export type CreateCommentData = Parameters<
  Liveblocks['createComment']
>[0]['data'];

export type CordThreadMetadata = {
  cordThreadId?: string;
  cordOrgId?: string;
  cordCreatedTimestamp?: string;
  /**
   * Stringified array of string values: Cord messages ids
   */
  cordMessagesIds?: string;
  cordUrl?: string;
  [ThreadMetadataKeys.MESSAGE_TO_COMMENT_PAIRS]?: string;
};

export type RoomWithThreads = RoomData & {
  threads: ThreadData<CordThreadMetadata>[];
};

export type CordOrgMetadata = {
  cordOrgId?: string;
  cordCreatedTimestamp?: string;
  cordState?: string;
  cordExternalId?: string;
};

export type ThreadCommentsMetadata = Array<ThreadCommentMetadata>;

export type ThreadCommentMetadata = {
  cordMessageId: string;
  liveblocksCommentId: string;
};
