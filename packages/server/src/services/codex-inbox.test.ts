import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatInboxEntryForCodex,
  readInboxCursor,
  readPendingInboxEntries,
  writeInboxCursor,
} from './codex-inbox.js';

describe('codex inbox', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-inbox-'));
    fs.mkdirSync(path.join(tmpDir, 'bridge', 'inbox'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads only unread inbox entries based on cursor state', () => {
    const inboxPath = path.join(tmpDir, 'bridge', 'inbox', 'marcus.jsonl');
    fs.writeFileSync(inboxPath, [
      JSON.stringify({ id: 'm1', agentKey: 'marcus', channelId: 'c1', author: 'Jeremy', content: 'first', timestamp: '2026-04-13T18:00:00.000Z' }),
      JSON.stringify({ id: 'm2', agentKey: 'marcus', channelId: 'c1', author: 'Jeremy', content: 'second', timestamp: '2026-04-13T18:01:00.000Z' }),
      '',
    ].join('\n'));

    writeInboxCursor(tmpDir, 'marcus', { lineCount: 1 });
    const pending = readPendingInboxEntries(tmpDir, 'marcus');

    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe('m2');
    expect(readInboxCursor(tmpDir, 'marcus').lineCount).toBe(2);
  });

  it('formats inbox entries into a readable Codex prompt', () => {
    const prompt = formatInboxEntryForCodex({
      id: 'm3',
      agentKey: 'marcus',
      channelId: 'c1',
      threadId: 't1',
      author: 'Jeremy',
      content: 'Can you reply to me?',
      timestamp: '2026-04-13T18:02:00.000Z',
    });

    expect(prompt).toContain('[Messaging Gateway]');
    expect(prompt).toContain('New Discord message from Jeremy');
    expect(prompt).toContain('Can you reply to me?');
  });
});
