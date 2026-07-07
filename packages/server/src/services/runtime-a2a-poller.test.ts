import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendPendingRow,
  readPendingRows,
  resolveA2APaths,
  type A2APendingTaskRow,
  type A2AGetTaskResult,
} from '@agent-comms/a2a-client';
import { createAgentMailStore } from '@agent-comms/mailbox';
import {
  computeNextPollDelay,
  readA2APollState,
  runA2APollerTick,
  writePendingRows,
  writeA2APollState,
} from './runtime-a2a-poller.js';

function pendingRow(overrides: Partial<A2APendingTaskRow> = {}): A2APendingTaskRow {
  const sentAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 29 * 60_000).toISOString();
  return {
    id: 'pending_1',
    peer: 'tomegibson',
    baseUrl: 'https://agents.tomegibson.com',
    endpointPath: '/',
    tokenFile: '',         // overridden per test
    fromAgent: 'isla',
    skillId: 'code-review',
    taskId: 'task_abc123',
    project: 'frontdesk',
    sentAt,
    expiresAt,
    callbackKind: 'agent-mail',
    ...overrides,
  };
}

function completedResult(text = 'LGTM'): A2AGetTaskResult {
  return { taskId: 'task_abc123', state: 'completed', result: {}, text, rawResponse: {} };
}

function workingResult(): A2AGetTaskResult {
  return { taskId: 'task_abc123', state: 'working', result: {}, text: undefined, rawResponse: {} };
}

describe('computeNextPollDelay', () => {
  it('returns 5s for early attempts', () => {
    expect(computeNextPollDelay(0)).toBe(5_000);
    expect(computeNextPollDelay(4)).toBe(5_000);
  });

  it('returns 30s for mid-range attempts', () => {
    expect(computeNextPollDelay(5)).toBe(30_000);
    expect(computeNextPollDelay(14)).toBe(30_000);
  });

  it('caps at 2 minutes', () => {
    expect(computeNextPollDelay(15)).toBe(120_000);
    expect(computeNextPollDelay(100)).toBe(120_000);
  });
});

describe('runA2APollerTick', () => {
  let tmpDir: string;
  let tokenFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-poller-'));
    tokenFile = path.join(tmpDir, 'token.txt');
    fs.writeFileSync(tokenFile, 'test-bearer');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makePaths() {
    return resolveA2APaths(tmpDir);
  }

  function makeMailStore() {
    const paths = makePaths();
    return createAgentMailStore(path.join(paths.root, 'mail', 'agent_mail.db'));
  }

  it('is a no-op when pending.jsonl is absent', async () => {
    await expect(runA2APollerTick({ paths: makePaths() })).resolves.not.toThrow();
  });

  it('removes completed task from pending and delivers to mailbox', async () => {
    const paths = makePaths();
    appendPendingRow(pendingRow({ tokenFile }), paths);

    const mailStore = makeMailStore();
    const getTaskImpl = vi.fn().mockResolvedValue(completedResult());

    await runA2APollerTick({ paths, mailStore, getTaskImpl });

    expect(readPendingRows(paths)).toEqual([]);
    const inbox = mailStore.listInbox({ agent: 'isla', status: 'new' });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.fromAgent).toBe('a2a:tomegibson');
    expect(inbox[0]!.subject).toContain('task_abc123');
    expect(inbox[0]!.bodyMd).toContain('LGTM');
    mailStore.close();
  });

  it('keeps task in pending when non-terminal state returned', async () => {
    const paths = makePaths();
    appendPendingRow(pendingRow({ tokenFile }), paths);

    const mailStore = makeMailStore();
    const getTaskImpl = vi.fn().mockResolvedValue(workingResult());

    await runA2APollerTick({ paths, mailStore, getTaskImpl });

    expect(readPendingRows(paths)).toHaveLength(1);
    const pollState = readA2APollState(paths);
    expect(pollState['pending_1']!.attempts).toBe(1);
    mailStore.close();
  });

  it('omits payload body for private project tasks', async () => {
    const paths = makePaths();
    appendPendingRow(pendingRow({ tokenFile, project: 'private' }), paths);

    const mailStore = makeMailStore();
    const getTaskImpl = vi.fn().mockResolvedValue(completedResult('secret content'));

    await runA2APollerTick({ paths, mailStore, getTaskImpl });

    const inbox = mailStore.listInbox({ agent: 'isla', status: 'new' });
    expect(inbox[0]!.bodyMd).not.toContain('secret content');
    expect(inbox[0]!.bodyMd).toContain('payload omitted');
    mailStore.close();
  });

  it('skips task not yet due based on nextPollAfter', async () => {
    const paths = makePaths();
    appendPendingRow(pendingRow({ tokenFile }), paths);
    writeA2APollState(paths, {
      pending_1: { attempts: 1, nextPollAfter: new Date(Date.now() + 60_000).toISOString() },
    });

    const getTaskImpl = vi.fn();
    await runA2APollerTick({ paths, getTaskImpl });

    expect(getTaskImpl).not.toHaveBeenCalled();
    expect(readPendingRows(paths)).toHaveLength(1);
  });

  it('expires task past expiresAt and delivers failure to mailbox', async () => {
    const paths = makePaths();
    appendPendingRow(pendingRow({ tokenFile, expiresAt: new Date(Date.now() - 1000).toISOString() }), paths);

    const mailStore = makeMailStore();
    const getTaskImpl = vi.fn();

    await runA2APollerTick({ paths, mailStore, getTaskImpl });

    expect(getTaskImpl).not.toHaveBeenCalled();
    expect(readPendingRows(paths)).toEqual([]);
    const inbox = mailStore.listInbox({ agent: 'isla', status: 'new' });
    expect(inbox[0]!.bodyMd).toContain('expired');
    mailStore.close();
  });

  it('uses callbackSubject as mail subject when present', async () => {
    const paths = makePaths();
    appendPendingRow(pendingRow({ tokenFile, callbackSubject: 'Review for PR #42' }), paths);

    const mailStore = makeMailStore();
    const getTaskImpl = vi.fn().mockResolvedValue(completedResult());

    await runA2APollerTick({ paths, mailStore, getTaskImpl });

    const inbox = mailStore.listInbox({ agent: 'isla', status: 'new' });
    expect(inbox[0]!.subject).toBe('Review for PR #42');
    mailStore.close();
  });

  it('threads result to existing correlation when correlationId present', async () => {
    const paths = makePaths();
    appendPendingRow(pendingRow({ tokenFile, correlationId: 'corr_existing' }), paths);

    const mailStore = makeMailStore();
    const getTaskImpl = vi.fn().mockResolvedValue(completedResult());

    await runA2APollerTick({ paths, mailStore, getTaskImpl });

    const inbox = mailStore.listInbox({ agent: 'isla', status: 'new' });
    expect(inbox[0]!.correlationId).toBe('corr_existing');
    mailStore.close();
  });

  it('processes intact rows and logs when pending.jsonl has a partial trailing line (C1)', async () => {
    const paths = makePaths();
    const good = pendingRow({ id: 'pending_good', taskId: 'task_good', tokenFile });
    fs.mkdirSync(paths.a2aDir, { recursive: true });
    // One valid row plus a truncated trailing line (a crash mid-append).
    fs.writeFileSync(paths.pendingFile, `${JSON.stringify(good)}\n{"id":"pending_bad","peer":"tom`);

    const logPath = path.join(tmpDir, 'poller.log');
    const mailStore = makeMailStore();
    const getTaskImpl = vi.fn().mockResolvedValue(completedResult('ok'));

    await expect(runA2APollerTick({ paths, mailStore, getTaskImpl, logPath })).resolves.not.toThrow();

    expect(getTaskImpl).toHaveBeenCalledTimes(1);
    expect(mailStore.listInbox({ agent: 'isla', status: 'new' })).toHaveLength(1);
    expect(fs.readFileSync(logPath, 'utf8')).toMatch(/malformed pending row/);
    mailStore.close();
  });

  it('leaves no temp files after writing pending and poll state (C1 atomic)', async () => {
    const paths = makePaths();
    appendPendingRow(pendingRow({ tokenFile }), paths);
    const mailStore = makeMailStore();

    await runA2APollerTick({ paths, mailStore, getTaskImpl: vi.fn().mockResolvedValue(workingResult()) });

    const files = fs.readdirSync(paths.a2aDir);
    expect(files.some((f) => f.includes('.tmp.'))).toBe(false);
    expect(files).toContain('pending.jsonl');
    expect(files).toContain('poll-state.json');
    mailStore.close();
  });

  it('preserves a row appended during the poll window (C2)', async () => {
    const paths = makePaths();
    appendPendingRow(pendingRow({ id: 'pending_1', taskId: 'task_1', tokenFile }), paths);

    const mailStore = makeMailStore();
    const getTaskImpl = vi.fn().mockImplementation(async () => {
      // A producer appends a new outbound row mid-poll — the race window.
      appendPendingRow(pendingRow({ id: 'pending_2', taskId: 'task_2', tokenFile }), paths);
      return completedResult('done-1');
    });

    await runA2APollerTick({ paths, mailStore, getTaskImpl });

    const ids = readPendingRows(paths).map((r) => r.id);
    expect(ids).toContain('pending_2');     // appended row not erased
    expect(ids).not.toContain('pending_1'); // completed row removed
    mailStore.close();
  });

  it('does not re-deliver a completed task whose row survived a crash (M1)', async () => {
    const paths = makePaths();
    appendPendingRow(pendingRow({ tokenFile }), paths);

    const mailStore = makeMailStore();
    const getTaskImpl = vi.fn().mockResolvedValue(completedResult());

    await runA2APollerTick({ paths, mailStore, getTaskImpl });
    expect(mailStore.listInbox({ agent: 'isla', status: 'new' })).toHaveLength(1);

    // Simulate a crash before pending cleanup: the same row reappears.
    appendPendingRow(pendingRow({ tokenFile }), paths);
    await runA2APollerTick({ paths, mailStore, getTaskImpl });

    // Still one delivery — the durable marker deduped the redelivery.
    expect(mailStore.listInbox({ agent: 'isla', status: 'new' })).toHaveLength(1);
    expect(readPendingRows(paths)).toEqual([]);
    mailStore.close();
  });

  it('retries the send when it crashed between send and marker, then dedupes once the marker lands (M1)', async () => {
    const paths = makePaths();
    appendPendingRow(pendingRow({ tokenFile }), paths);

    const mailStore = makeMailStore();
    const getTaskImpl = vi.fn().mockResolvedValue(completedResult());

    // Tick 1 sends the result and writes the marker.
    await runA2APollerTick({ paths, mailStore, getTaskImpl });
    expect(mailStore.listInbox({ agent: 'isla', status: 'new' })).toHaveLength(1);

    // Simulate a crash BETWEEN send and marker: the mail went out but the marker
    // never landed and the row was never pruned. The result must NOT be lost —
    // the next tick has to re-send, not silently drop the row.
    fs.rmSync(path.join(paths.a2aDir, 'delivered.jsonl'));
    appendPendingRow(pendingRow({ tokenFile }), paths);
    await runA2APollerTick({ paths, mailStore, getTaskImpl });
    expect(mailStore.listInbox({ agent: 'isla', status: 'new' })).toHaveLength(2); // re-sent, no loss

    // The marker is present again, so a further stray copy of the row is deduped.
    appendPendingRow(pendingRow({ tokenFile }), paths);
    await runA2APollerTick({ paths, mailStore, getTaskImpl });
    expect(mailStore.listInbox({ agent: 'isla', status: 'new' })).toHaveLength(2); // no resend
    mailStore.close();
  });

  it('prunes an orphaned pollState entry (L1)', async () => {
    const paths = makePaths();
    appendPendingRow(pendingRow({ id: 'pending_live', tokenFile }), paths);
    writeA2APollState(paths, {
      pending_live: { attempts: 0, nextPollAfter: new Date(Date.now() - 1000).toISOString() },
      pending_ghost: { attempts: 3, nextPollAfter: new Date(Date.now() - 1000).toISOString() },
    });

    const mailStore = makeMailStore();
    const getTaskImpl = vi.fn().mockResolvedValue(workingResult());

    await runA2APollerTick({ paths, mailStore, getTaskImpl });

    const state = readA2APollState(paths);
    expect(state['pending_ghost']).toBeUndefined(); // orphan pruned
    expect(state['pending_live']).toBeDefined();     // live row kept
    mailStore.close();
  });

  it('writes audit rows for poll and deliver events', async () => {
    const paths = makePaths();
    appendPendingRow(pendingRow({ tokenFile, project: 'frontdesk' }), paths);

    const mailStore = makeMailStore();
    const getTaskImpl = vi.fn().mockResolvedValue(completedResult());
    await runA2APollerTick({ paths, mailStore, getTaskImpl });
    mailStore.close();

    const auditLines = fs.readFileSync(paths.auditFile, 'utf8').trim().split('\n');
    const events = auditLines.map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events).toContain('poll');
    expect(events).toContain('deliver');
  });
});

function writeA2APollState(paths: ReturnType<typeof resolveA2APaths>, state: object): void {
  fs.mkdirSync(paths.a2aDir, { recursive: true });
  fs.writeFileSync(`${paths.a2aDir}/poll-state.json`, JSON.stringify(state, null, 2));
}
