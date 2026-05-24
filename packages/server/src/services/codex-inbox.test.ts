import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatInboxEntryForCodex,
  markInboxEntryDelivered,
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

  it('reads unread inbox entries without advancing the cursor before delivery ack', () => {
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
    expect(readInboxCursor(tmpDir, 'marcus').lineCount).toBe(1);
  });

  it('advances the cursor only after the next pending entry is marked delivered', () => {
    const inboxPath = path.join(tmpDir, 'bridge', 'inbox', 'marcus.jsonl');
    fs.writeFileSync(inboxPath, [
      JSON.stringify({ id: 'm1', agentKey: 'marcus', channelId: 'c1', author: 'Jeremy', content: 'first', timestamp: '2026-04-13T18:00:00.000Z' }),
      JSON.stringify({ id: 'm2', agentKey: 'marcus', channelId: 'c1', author: 'Jeremy', content: 'second', timestamp: '2026-04-13T18:01:00.000Z' }),
      '',
    ].join('\n'));

    const [first, second] = readPendingInboxEntries(tmpDir, 'marcus');

    expect(markInboxEntryDelivered(tmpDir, 'marcus', second!)).toBe(false);
    expect(readInboxCursor(tmpDir, 'marcus').lineCount).toBe(0);
    expect(markInboxEntryDelivered(tmpDir, 'marcus', first!)).toBe(true);
    expect(readInboxCursor(tmpDir, 'marcus').lineCount).toBe(1);
    expect(markInboxEntryDelivered(tmpDir, 'marcus', second!)).toBe(true);
    expect(readInboxCursor(tmpDir, 'marcus').lineCount).toBe(2);
  });

  it('keeps a message pending when injection fails before delivery ack', () => {
    const inboxPath = path.join(tmpDir, 'bridge', 'inbox', 'marcus.jsonl');
    fs.writeFileSync(inboxPath, [
      JSON.stringify({ id: 'm1', agentKey: 'marcus', channelId: 'c1', author: 'Jeremy', content: 'first', timestamp: '2026-04-13T18:00:00.000Z' }),
      '',
    ].join('\n'));

    expect(readPendingInboxEntries(tmpDir, 'marcus')).toHaveLength(1);
    expect(readInboxCursor(tmpDir, 'marcus').lineCount).toBe(0);
    expect(readPendingInboxEntries(tmpDir, 'marcus')).toHaveLength(1);
  });

  it('formats inbox entries into a readable Codex prompt', () => {
    const prompt = formatInboxEntryForCodex({
      id: 'm3',
      bindingName: 'eli',
      agentKey: 'marcus',
      channelId: 'c1',
      threadId: 't1',
      author: 'Jeremy',
      authorId: 'u1',
      content: 'Can you reply to me?',
      timestamp: '2026-04-13T18:02:00.000Z',
    });

    expect(prompt).toContain('[Messaging Gateway]');
    expect(prompt).toContain('<channel source="discord" chat_id="c1" message_id="m3" user="Jeremy"');
    expect(prompt).toContain('thread_id="t1"');
    expect(prompt).toContain('Can you reply to me?');
    expect(prompt).toContain('--text-file /absolute/path/to/reply.txt');
    expect(prompt).toContain('chat_id="c1"');
    expect(prompt).toContain('Reply on Discord');
  });

  it('formats attachment metadata for Codex prompts', () => {
    const prompt = formatInboxEntryForCodex({
      id: 'm4',
      bindingName: 'enzo',
      agentKey: 'enzo',
      channelId: 'c2',
      author: 'Jeremy',
      content: '',
      timestamp: '2026-04-13T18:03:00.000Z',
      attachments: [{
        filename: 'voice "one".ogg',
        content_type: 'audio/ogg',
        size: 2345,
        url: 'https://cdn.discordapp.com/attachments/voice.ogg?ex=1&is=2',
      }],
    });

    expect(prompt).toContain('<attachments>');
    expect(prompt).toContain('filename="voice &quot;one&quot;.ogg"');
    expect(prompt).toContain('content_type="audio/ogg"');
    expect(prompt).toContain('size="2345"');
    expect(prompt).toContain('url="https://cdn.discordapp.com/attachments/voice.ogg?ex=1&amp;is=2"');
  });
});
