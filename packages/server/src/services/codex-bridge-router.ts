import type {
  CodexBridgeBinding,
  CodexBridgeConfig,
  CodexBridgeInboxEntry,
  CodexBridgeSubscription,
  DiscordMessageEvent,
} from '../types/codex-bridge.js';

export function matchesSubscription(
  subscription: CodexBridgeSubscription,
  event: DiscordMessageEvent,
): boolean {
  if (subscription.threadId) {
    return event.channel_id === subscription.threadId;
  }
  return event.channel_id === subscription.channelId;
}

export function shouldIgnoreDiscordMessage(
  config: CodexBridgeConfig,
  event: DiscordMessageEvent,
): boolean {
  if (!event.content?.trim() && !event.attachments?.length) return true;
  if (config.selfUserId && event.author?.id === config.selfUserId) return true;
  return false;
}

export function routeDiscordMessage(
  config: CodexBridgeConfig,
  event: DiscordMessageEvent,
): CodexBridgeInboxEntry | null {
  if (shouldIgnoreDiscordMessage(config, event)) return null;

  const subscription = config.subscriptions.find((item) => matchesSubscription(item, event));
  if (!subscription) return null;

  if (event.author?.bot && !subscription.allowBotIds?.includes(event.author.id!)) return null;

  return {
    id: event.id,
    agentKey: subscription.agentKey,
    channelId: subscription.channelId,
    threadId: subscription.threadId,
    author: event.author?.username ?? 'unknown',
    authorId: event.author?.id,
    content: event.content,
    attachments: event.attachments?.map((attachment) => ({
      url: attachment.url,
      filename: attachment.filename,
      content_type: attachment.content_type,
      size: attachment.size,
    })),
    timestamp: event.timestamp ?? new Date().toISOString(),
  };
}

export function routeDiscordMessageForBinding(
  binding: CodexBridgeBinding,
  event: DiscordMessageEvent,
): CodexBridgeInboxEntry | null {
  const scopedConfig: CodexBridgeConfig = {
    tokenEnvVar: binding.tokenEnvVar,
    selfUserId: binding.selfUserId,
    subscriptions: binding.subscriptions,
  };
  const routed = routeDiscordMessage(scopedConfig, event);
  if (!routed) return null;
  return {
    ...routed,
    bindingName: binding.name,
  };
}
