import { describe, expect, it } from 'vitest';
import { buildHistoryPayload, parseArgs } from './discord-bridge-history.js';

describe('discord bridge history CLI', () => {
  it('builds a daemon history payload without any Discord token material', () => {
    const args = parseArgs([
      '--agent', 'eli',
      '--chat-id', '1493425484036309092',
      '--limit', '10',
      '--after', '123',
      '--binding', 'hq',
    ]);

    expect(JSON.parse(buildHistoryPayload(args))).toEqual({
      agentKey: 'eli',
      chat_id: '1493425484036309092',
      bindingName: 'hq',
      limit: 10,
      after: '123',
    });
  });

  it('rejects invalid history limits locally', () => {
    const args = parseArgs(['--agent', 'eli', '--chat-id', 'c1', '--limit', '0']);

    expect(() => buildHistoryPayload(args)).toThrow('--limit must be an integer from 1 to 100');
  });
});
