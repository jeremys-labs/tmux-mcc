import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cannotActOn, recoverInboundMiss } from './inbound-miss-recovery.js';
import type { ReplyMiss } from './inbound-reply-reconcile.js';

const roots: string[] = [];

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-miss-recovery-'));
  roots.push(value);
  return value;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function miss(failureClass: ReplyMiss['failureClass']): ReplyMiss {
  return {
    key: 'marcus:chat-1:in-1',
    agent: 'marcus',
    chatId: 'chat-1',
    inboundMessageId: 'in-1',
    queuedAt: '2026-08-26T13:00:00.000Z',
    ageMinutes: 10,
    graceMinutes: 10,
    failureClass,
    detail: 'test miss',
  };
}

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe('recoverInboundMiss', () => {
  it('wakes a still-queued message without appending a duplicate', () => {
    const contentRoot = root();
    const inbox = path.join(contentRoot, 'bridge', 'inbox', 'marcus.jsonl');
    writeJsonl(inbox, [{ id: 'in-1', agentKey: 'marcus', channelId: 'chat-1', content: 'hello' }]);

    const result = recoverInboundMiss({
      miss: miss('queued_not_consumed'),
      contentRoot,
      supervisorStatuses: [],
      dependencies: { wake: () => ({ attempted: true, ok: true, target: 'agents:marcus' }) },
    });

    expect(result).toMatchObject({ ok: true, action: 'wake_queued' });
    expect(fs.readFileSync(inbox, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('replays a consumed idle message, records the recovery expectation, and wakes the runtime', () => {
    const contentRoot = root();
    const inbox = path.join(contentRoot, 'bridge', 'inbox', 'marcus.jsonl');
    writeJsonl(inbox, [{ id: 'in-1', agentKey: 'marcus', channelId: 'chat-1', content: 'hello', bindingName: 'marcus' }]);
    writeJson(path.join(contentRoot, 'bridge', 'runtime-state', 'marcus.json'), { lineCount: 1 });
    writeJsonl(path.join(contentRoot, 'bridge', 'reconcile', 'inbound-expected.jsonl'), [{
      queued_at: '2026-08-26T13:00:00.000Z', agent: 'marcus', chat_id: 'chat-1', message_id: 'in-1', binding: 'marcus', inbox_path: inbox,
    }]);

    const result = recoverInboundMiss({
      miss: miss('consumed_idle_no_reply'),
      contentRoot,
      supervisorStatuses: [{ agent: 'marcus', process: { status: 'running' }, progress: { status: 'idle' } }],
      dependencies: {
        now: new Date('2026-08-26T13:10:00.000Z'),
        wake: () => ({ attempted: true, ok: true, target: 'agents:marcus' }),
      },
    });

    expect(result).toMatchObject({ ok: true, action: 'replay_consumed' });
    const inboxRows = fs.readFileSync(inbox, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(inboxRows).toHaveLength(2);
    expect(inboxRows[1]).toMatchObject({ id: 'in-1', replayed_from: 'in-1' });
    const expectedRows = fs.readFileSync(path.join(contentRoot, 'bridge', 'reconcile', 'inbound-expected.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(expectedRows[1]).toMatchObject({ queued_at: '2026-08-26T13:10:00.000Z', message_id: 'in-1' });
  });

  it('reports wake failure so the monitor can notify Jeremy immediately', () => {
    const result = recoverInboundMiss({
      miss: miss('queued_not_consumed'),
      contentRoot: root(),
      supervisorStatuses: [],
      dependencies: { wake: () => ({ attempted: true, ok: false, reason: 'tmux target missing' }) },
    });
    expect(result).toMatchObject({ ok: false, action: 'wake_queued' });
  });
});

describe('cannotActOn (dc-20261011-006)', () => {
  // The vocabulary is NOT invented here: inbound-reply-reconcile.ts branches on exactly
  // these progress values ('hung' :304, 'blocked' :311, 'idle' :318).
  it('names blocked, hung and a dead process as unable to act', () => {
    expect(cannotActOn({ processStatus: 'running', progressStatus: 'blocked' })).toBe('blocked');
    expect(cannotActOn({ processStatus: 'running', progressStatus: 'hung' })).toBe('hung');
    expect(cannotActOn({ processStatus: 'dead', progressStatus: 'unknown' })).toBe('process dead');
  });

  it('a healthy or merely idle runtime is NOT reported as unable to act', () => {
    // An idle runtime is the ordinary success case: it will pick the replay up. Treating
    // idle as stuck would turn every genuine recovery into a warning and retire the signal.
    expect(cannotActOn({ processStatus: 'running', progressStatus: 'idle' })).toBeNull();
    expect(cannotActOn({ processStatus: 'running', progressStatus: 'processing' })).toBeNull();
  });

  it('no supervisor row returns null -- absence of evidence, not evidence of health', () => {
    // null means we could not observe the runtime. It renders as the ordinary notice, which
    // is the pre-existing behaviour and is deliberately NOT a new warning: inventing a
    // "possibly stuck" state for every agent the supervisor has not listed is how a guard
    // becomes noise and gets ignored. The limit is stated rather than hidden.
    expect(cannotActOn(null)).toBeNull();
  });
});

describe('recoverInboundMiss carries liveness (dc-20261011-006)', () => {
  it('attaches the supervisor progress status and its detail to the result', () => {
    const contentRoot = root();
    writeJsonl(path.join(contentRoot, 'bridge', 'inbox', 'marcus.jsonl'), [
      { id: 'in-1', agentKey: 'marcus', channelId: 'chat-1', bindingName: 'marcus', text: 'hello' },
    ]);
    writeJsonl(path.join(contentRoot, 'bridge', 'inbound-expected.jsonl'), [
      { queued_at: '2026-08-26T13:00:00.000Z', agent: 'marcus', chat_id: 'chat-1', message_id: 'in-1', binding: 'marcus', inbox_path: 'x' },
    ]);
    writeJson(path.join(contentRoot, 'bridge', 'runtime-state', 'marcus.json'), { lineCount: 1 });
    const result = recoverInboundMiss({
      miss: miss('consumed_blocked'),
      contentRoot,
      supervisorStatuses: [{
        agent: 'marcus',
        process: { status: 'running' },
        progress: { status: 'blocked', detail: 'codex usage limit reached' },
      }],
      dependencies: { wake: () => ({ attempted: true, ok: true, target: 'agents:marcus' }) },
    });
    // The point of the row: this field existed inside livenessFor() all along and the
    // result shape dropped it, so the notice could not qualify its own claim.
    expect(result.liveness).toMatchObject({
      processStatus: 'running',
      progressStatus: 'blocked',
      progressDetail: 'codex usage limit reached',
    });
    expect(cannotActOn(result.liveness)).toBe('blocked');
  });

  it('a result from a path that never read the inbox still reports liveness', () => {
    // Every return carries it, which is why the field is required and not optional: an
    // early return that omitted it would silently restore the unqualified claim.
    const result = recoverInboundMiss({
      miss: miss('consumed_blocked'),
      contentRoot: root(),
      supervisorStatuses: [{ agent: 'marcus', process: { status: 'running' }, progress: { status: 'blocked' } }],
      dependencies: { wake: () => ({ attempted: true, ok: true }) },
    });
    expect(result.ok).toBe(false);          // no inbox file in this root
    expect(result.liveness).toMatchObject({ progressStatus: 'blocked' });
  });
});
