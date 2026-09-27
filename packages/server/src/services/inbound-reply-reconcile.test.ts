import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatInboundReplyMissAlert,
  inboundReplyMissFingerprint,
  latestInboundExpectations,
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
  it('uses the newest replay expectation for one logical inbound message', () => {
    const records = [
      inbound({ queued_at: '2026-07-12T13:00:00.000Z' }),
      inbound({ queued_at: '2026-07-12T13:25:00.000Z' }),
    ];
    expect(latestInboundExpectations(records)).toEqual([records[1]]);

    const result = reconcileInboundReplies({
      expected: records,
      outbound: [],
      contentRoot: tempDir(),
      now: new Date('2026-07-12T13:30:00.000Z'),
    });
    expect(result.expectedCount).toBe(1);
    expect(result.deferredCount).toBe(1);
    expect(result.misses).toEqual([]);
  });

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
    // Moved here 2026-09-27 from the consumed_idle_no_reply test, which no longer produces a
    // miss. This was the ONLY inboundReplyMissFingerprint assertion in the suite: leaving it
    // where it was would have made it assert over an always-empty array, and deleting it would
    // have removed that function's entire coverage to make a change of mine pass.
    expect(inboundReplyMissFingerprint(result.misses)).toContain('cecelia:chat-1:in-1:unknown_consumption_no_reply');
    // Relocated with it for the same reason: this was the suite's ONLY
    // formatInboundReplyMissAlert assertion, and it also lived in the test whose class no
    // longer produces a miss. Changing one class's routing knocked out the sole coverage of
    // TWO exported functions, which is worth knowing about this suite.
    expect(formatInboundReplyMissAlert(result)).toContain('class=unknown_consumption_no_reply');
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

  // RETARGETED 2026-09-27 misses -> undecidable. The property is unchanged: the class is
  // CLASSIFIED and not dropped. What changed is that it is no longer a FINDING, because
  // `hasReply` reads an outbox that never records an interactive send, so a healthy agent and
  // a dead one produce the identical observation and this branch has no true-positive
  // capability. Dead/hung/blocked keep their own classes and still flag.
  it('classifies consumed idle no-reply as UNDECIDABLE, not as a finding', () => {
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

    expect(result.misses).toHaveLength(0);
    expect(result.undecidable).toHaveLength(1);
    expect(result.undecidable[0]).toMatchObject({
      failureClass: 'consumed_idle_no_reply',
      ageMinutes: 30,
      graceMinutes: 10,
    });
    // The NEGATIVE, which is the property that matters: an undecidable never reaches the alert.
    // Asserting only the bucket would pass if the formatter also read `undecidable`.
    expect(formatInboundReplyMissAlert(result)).not.toContain('consumed_idle_no_reply');
  });
});
