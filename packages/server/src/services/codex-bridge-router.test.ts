import { describe, expect, it } from 'vitest';
import { routeDiscordMessage, routeDiscordMessageForBinding, shouldIgnoreDiscordMessage } from './codex-bridge-router.js';

const config = {
  selfUserId: 'bot-user',
  subscriptions: [
    { agentKey: 'marcus', channelId: '1492892431543308439' },
    { agentKey: 'eli', channelId: '999', threadId: '12345' },
  ],
};

describe('codex bridge router', () => {
  it('routes a channel message to the matching agent', () => {
    const routed = routeDiscordMessage(config as any, {
      id: 'm1',
      channel_id: '1492892431543308439',
      content: 'Hey',
      author: { id: 'user1', username: 'Jeremy' },
      timestamp: '2026-04-13T18:00:00.000Z',
    });

    expect(routed?.agentKey).toBe('marcus');
    expect(routed?.author).toBe('Jeremy');
  });

  it('ignores messages from the configured self user', () => {
    expect(shouldIgnoreDiscordMessage(config as any, {
      id: 'm2',
      channel_id: '1492892431543308439',
      content: 'bot echo',
      author: { id: 'bot-user', username: 'bridge' },
    })).toBe(true);
  });

  it('routes thread traffic only to the matching thread subscription', () => {
    const routed = routeDiscordMessage(config as any, {
      id: 'm3',
      channel_id: '12345',
      content: 'thread note',
      author: { id: 'user2', username: 'Jeremy' },
    });

    expect(routed?.agentKey).toBe('eli');
    expect(routed?.threadId).toBe('12345');
  });

  it('ignores bot messages by default', () => {
    const routed = routeDiscordMessage(config as any, {
      id: 'm5',
      channel_id: '1492892431543308439',
      content: 'bot says hi',
      author: { id: 'bot-123', username: 'SomeBot', bot: true },
    });
    expect(routed).toBeNull();
  });

  it('allows bot messages when author ID is in allowBotIds', () => {
    const configWithBots = {
      ...config,
      subscriptions: [
        { agentKey: 'marcus', channelId: '1492892431543308439', allowBotIds: ['bot-123'] },
        config.subscriptions[1],
      ],
    };
    const routed = routeDiscordMessage(configWithBots as any, {
      id: 'm6',
      channel_id: '1492892431543308439',
      content: 'allowed bot says hi',
      author: { id: 'bot-123', username: 'Donna', bot: true },
    });
    expect(routed?.agentKey).toBe('marcus');
    expect(routed?.author).toBe('Donna');
  });

  it('blocks bot messages when author ID is not in allowBotIds', () => {
    const configWithBots = {
      ...config,
      subscriptions: [
        { agentKey: 'marcus', channelId: '1492892431543308439', allowBotIds: ['bot-999'] },
        config.subscriptions[1],
      ],
    };
    const routed = routeDiscordMessage(configWithBots as any, {
      id: 'm7',
      channel_id: '1492892431543308439',
      content: 'unlisted bot',
      author: { id: 'bot-123', username: 'RandomBot', bot: true },
    });
    expect(routed).toBeNull();
  });

  it('adds binding metadata when routing through a specific binding', () => {
    const routed = routeDiscordMessageForBinding({
      name: 'zara',
      tokenEnvVar: 'DISCORD_BOT_TOKEN_ZARA',
      subscriptions: [{ agentKey: 'zara', channelId: '1492551894214905886' }],
    }, {
      id: 'm4',
      channel_id: '1492551894214905886',
      content: 'hello zara',
      author: { id: 'user3', username: 'Jeremy' },
    });

    expect(routed?.bindingName).toBe('zara');
    expect(routed?.agentKey).toBe('zara');
  });
});
