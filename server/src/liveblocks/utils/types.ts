import type { Liveblocks, RoomData, ThreadData } from '@liveblocks/node';
import type { Location } from 'common/types/index.ts';
import type { MessageEntity } from 'server/src/entity/message/MessageEntity.ts';
import type { ThreadMetadataKeys } from 'server/src/liveblocks/utils/index.ts';
import type { getCordData } from 'server/src/liveblocks/LiveblocksMigrationHandler.ts';

export type CordData = Awaited<ReturnType<typeof getCordData>>;

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

export type ThreadEntityFull = CordData['threads'][number] & {
  location: Location;
  messages: MessageEntity[];
};
