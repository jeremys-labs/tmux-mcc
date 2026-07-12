import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatInboundReplyMissAlert,
  inboundReplyMissFingerprint,
  reconcileInboundReplies,
  type InboundExpectedRecord,
  type OutboundSentRecord,
  type SupervisorAgentStatus,
} from './inbound-reply-reconcile.js';

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-reply-reconcile-'));
  tempRoots.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

function inbound(overrides: Partial<InboundExpectedRecord> = {}): InboundExpectedRecord {
  return {
    queued_at: '2026-07-12T13:00:00.000Z',
    agent: 'cecelia',
    chat_id: 'chat-1',
    message_id: 'in-1',
    binding: 'cecelia',
    ...overrides,
  };
}

function outbound(overrides: Partial<OutboundSentRecord> = {}): OutboundSentRecord {
  return {
    sent_at: '2026-07-12T13:05:00.000Z',
    agent: 'cecelia',
    chat_id: 'chat-1',
    message_id: 'out-1',
    binding: 'cecelia',
    ...overrides,
  };
}

function status(overrides: Partial<SupervisorAgentStatus> = {}): SupervisorAgentStatus {
  return {
    agent: 'cecelia',
    process: { status: 'running', pid: 123 },
    progress: { status: 'idle', detail: 'awaiting input' },
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('reconcileInboundReplies', () => {
  it('matches any later outbound send by the same agent to the same chat', () => {
    const result = reconcileInboundReplies({
      expected: [inbound()],
      outbound: [outbound()],
      contentRoot: tempDir(),
      now: new Date('2026-07-12T13:30:00.000Z'),
    });

    expect(result.matchedCount).toBe(1);
    expect(result.misses).toEqual([]);
  });

  it('does not match sends before the inbound queue time', () => {
    const result = reconcileInboundReplies({
      expected: [inbound()],
      outbound: [outbound({ sent_at: '2026-07-12T12:59:59.000Z' })],
      contentRoot: tempDir(),
      supervisorStatuses: [status()],
      now: new Date('2026-07-12T13:30:00.000Z'),
    });

    expect(result.misses[0]).toMatchObject({
      failureClass: 'unknown_consumption_no_reply',
      agent: 'cecelia',
      inboundMessageId: 'in-1',
    });
  });

  it('honors per-agent opt-outs and grace windows', () => {
    const result = reconcileInboundReplies({
      expected: [
        inbound({ message_id: 'skipped', agent: 'remy' }),
        inbound({ message_id: 'deferred', agent: 'cecelia' }),
      ],
      outbound: [],
      contentRoot: tempDir(),
      policy: {
        defaultGraceMinutes: 10,
        agents: {
          remy: { optOut: true },
          cecelia: { graceMinutes: 45 },
        },
      },
      now: new Date('2026-07-12T13:30:00.000Z'),
    });

    expect(result.skippedCount).toBe(1);
    expect(result.deferredCount).toBe(1);
    expect(result.misses).toEqual([]);
  });

  it('classifies queued-not-consumed using the runtime cursor', () => {
    const root = tempDir();
    const inboxPath = path.join(root, 'bridge', 'inbox', 'cecelia.jsonl');
    writeJsonl(inboxPath, [{ id: 'in-1' }]);
    writeJson(path.join(root, 'bridge', 'runtime-state', 'cecelia.json'), { lineCount: 0 });

    const result = reconcileInboundReplies({
      expected: [inbound({ inbox_path: inboxPath })],
      outbound: [],
      contentRoot: root,
      supervisorStatuses: [status()],
      now: new Date('2026-07-12T13:30:00.000Z'),
    });

    expect(result.misses[0].failureClass).toBe('queued_not_consumed');
  });

  it('defers active processing after the grace window', () => {
    const root = tempDir();
    const inboxPath = path.join(root, 'bridge', 'inbox', 'cecelia.jsonl');
    writeJsonl(inboxPath, [{ id: 'in-1' }]);
    writeJson(path.join(root, 'bridge', 'runtime-state', 'cecelia.json'), { lineCount: 1 });

    const result = reconcileInboundReplies({
      expected: [inbound({ inbox_path: inboxPath })],
      outbound: [],
      contentRoot: root,
      supervisorStatuses: [status({ progress: { status: 'processing', detail: 'mid-turn' } })],
      now: new Date('2026-07-12T13:30:00.000Z'),
    });

    expect(result.deferredCount).toBe(1);
    expect(result.misses).toEqual([]);
  });

  it('classifies consumed idle no-reply misses', () => {
    const root = tempDir();
    const inboxPath = path.join(root, 'bridge', 'inbox', 'cecelia.jsonl');
    writeJsonl(inboxPath, [{ id: 'in-1' }]);
    writeJson(path.join(root, 'bridge', 'runtime-state', 'cecelia.json'), { lineCount: 1 });

    const result = reconcileInboundReplies({
      expected: [inbound({ inbox_path: inboxPath })],
      outbound: [],
      contentRoot: root,
      supervisorStatuses: [status()],
      now: new Date('2026-07-12T13:30:00.000Z'),
    });

    expect(result.misses[0]).toMatchObject({
      failureClass: 'consumed_idle_no_reply',
      ageMinutes: 30,
      graceMinutes: 10,
    });
    expect(inboundReplyMissFingerprint(result.misses)).toContain('cecelia:chat-1:in-1:consumed_idle_no_reply');
    expect(formatInboundReplyMissAlert(result)).toContain('class=consumed_idle_no_reply');
  });
});
