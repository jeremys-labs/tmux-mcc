import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendInboxEntry, hasSeen, markSeen, readBridgeState } from './codex-bridge-store.js';

describe('codex bridge store', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends an inbox entry for an agent', () => {
    const filePath = appendInboxEntry(tmpDir, {
      id: 'm1',
      agentKey: 'marcus',
      channelId: 'c1',
      author: 'Jeremy',
      content: 'hello',
      timestamp: '2026-04-13T18:00:00.000Z',
    });

    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).agentKey).toBe('marcus');
  });

  it('tracks last seen message IDs', () => {
    expect(hasSeen(tmpDir, 'marcus:c1', 'm1')).toBe(false);
    markSeen(tmpDir, 'marcus:c1', 'm1');
    expect(hasSeen(tmpDir, 'marcus:c1', 'm1')).toBe(true);
    expect(readBridgeState(tmpDir).lastSeenMessageIds['marcus:c1']).toBe('m1');
  });
});
