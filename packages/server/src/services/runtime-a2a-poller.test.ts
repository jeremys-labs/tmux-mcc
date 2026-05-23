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
