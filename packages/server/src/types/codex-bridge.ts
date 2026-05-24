export interface CodexBridgeSubscription {
  agentKey: string;
  channelId: string;
  threadId?: string;
  workspaceDir?: string;
  allowBotIds?: string[];
}

export interface CodexBridgeConfig {
  bindings?: CodexBridgeBinding[];
  tokenEnvVar?: string;
  selfUserId?: string;
  subscriptions: CodexBridgeSubscription[];
}

export interface CodexBridgeBinding {
  name: string;
  tokenEnvVar: string;
  selfUserId?: string;
  subscriptions: CodexBridgeSubscription[];
}

export interface DiscordMessageEvent {
  id: string;
  channel_id: string;
  content: string;
  attachments?: DiscordMessageAttachment[];
  author?: {
    id?: string;
    username?: string;
    bot?: boolean;
  };
  guild_id?: string;
  timestamp?: string;
  referenced_message?: {
    id?: string;
    author?: {
      id?: string;
      username?: string;
    };
  } | null;
}

export interface DiscordMessageAttachment {
  id?: string;
  url: string;
  filename: string;
  content_type?: string;
  size?: number;
}

export interface CodexBridgeInboxEntry {
  id: string;
  bindingName?: string;
  agentKey: string;
  channelId: string;
  threadId?: string;
  author: string;
  authorId?: string;
  content: string;
  attachments?: CodexBridgeAttachment[];
  timestamp: string;
}

export interface CodexBridgeAttachment {
  url: string;
  filename: string;
  content_type?: string;
  size?: number;
}
