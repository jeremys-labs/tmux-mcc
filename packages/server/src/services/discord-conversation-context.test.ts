import { describe, expect, it } from 'vitest';
import { formatRecentDiscordHistory } from './discord-conversation-context.js';

describe('Discord conversation context', () => {
  it('orders newest-first bridge history chronologically and labels the exact boundary', () => {
    const context = formatRecentDiscordHistory([
      { id: '2', author: 'Dana', content: 'Supervisor escalation is queued.', timestampIso: '2026-09-24T02:33:10Z' },
      { id: '1', author: 'Jeremy', content: 'What did they say?', timestampIso: '2026-09-24T02:32:28Z' },
    ], 'channel-1', 'current-3');

    expect(context).toContain('chat_id="channel-1" before_message_id="current-3"');
    expect(context.indexOf('What did they say?')).toBeLessThan(context.indexOf('Supervisor escalation is queued.'));
    expect(context).toContain('Do not repeat completed actions');
  });

  it('represents an empty channel without inventing context', () => {
    expect(formatRecentDiscordHistory([], 'channel-1', 'current-1')).toContain('(no earlier messages in this channel)');
  });
});
