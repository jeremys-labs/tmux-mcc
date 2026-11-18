import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runOpenBrainRuntimeHealthMonitor,
  type RuntimeHealthMonitorOptions,
} from './open-brain-runtime-health-monitor.js';
import type { RuntimeHealthReport } from './services/runtime-health.js';
import type { SupervisorAgentStatus } from './services/inbound-reply-reconcile.js';

/**
 * THE MULTI-PASS HARNESS (dc-20261102-011).
 *
 * `runOpenBrainRuntimeHealthMonitor` had no test of any kind before this file; the row's premise
 * is that main() has none, and this is the artifact that answers it. Every fixture here drives the
 * REAL orchestration over REAL FILES across CONSECUTIVE PASSES, carrying the state file between
 * them the way production does, because findings A and B are both properties of what one pass
 * leaves behind for the next one and are invisible to a single-pass test.
 *
 * WHAT IS REAL AND WHAT IS INJECTED, stated because the distinction is the whole design:
 *   real -- the state file, the expectation/outbound/policy/cursor/inbox files, reconcile,
 *           the recovery attempt (which genuinely appends a replay entry and a fresh
 *           expectation), decideRecovery, the fingerprint logic and the alert text.
 *   injected -- the health report and supervisor statuses (main() resolves those from module
 *           constants no flag can redirect, so a subprocess harness would assert against live
 *           fleet state), the two senders, and `wake` (waking a runtime is a real side effect
 *           against the fleet).
 *
 * THE SUBJECT IS NEVER THE DESTINATION. `partitionBySubject` withholds a finding from its own
 * subject's channel, so a fixture whose subject equalled `agent` would be withheld and every
 * assertion below would pass for the wrong reason. Subject is `testbot`, destination is `eli`.
 */

const SUBJECT = 'testbot';
const DESTINATION = 'eli';
const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-harness-'));
  tempRoots.push(dir);
  return dir;
}

function writeLines(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A report with nothing wrong in it, so the only findings a fixture can produce are inbound. */
function cleanReport(generatedAtIso: string): RuntimeHealthReport {
  return {
    generatedAtIso,
    durationMs: 1,
    scheduler: {
      jobsFile: '/tmp/jobs.json',
      validJobTypes: ['once', 'recurring'],
      jobCount: 0,
      invalidTypeJobs: [],
      staleOneShotJobs: [],
      staleRecurringJobs: [],
      notificationDeliveryFailures: [],
      checks: {
        jobTypes: { status: 'ok', detail: 'ok' },
        staleOneShots: { status: 'ok', detail: 'ok' },
        staleRecurring: { status: 'ok', detail: 'ok' },
        notificationDelivery: { status: 'ok', detail: 'ok' },
      },
    },
    agentMail: { dbPath: '/tmp/agent-mail.db', agents: {}, outbox: { status: 'ok', detail: 'ok' } },
    summary: { status: 'ok', detail: 'ok' },
    agents: [],
  } as unknown as RuntimeHealthReport;
}

function status(progress: 'processing' | 'blocked' | 'idle' | 'hung', process_ = 'running'): SupervisorAgentStatus {
  return {
    agent: SUBJECT,
    process: { status: process_ },
    progress: { status: progress, detail: `${progress} for the test` },
  } as unknown as SupervisorAgentStatus;
}

interface PassResult {
  stdout: string;
  mails: { subject: string; body: string }[];
  /** True if, AT SEND TIME, the state file did not yet carry this pass's fingerprint. */
  sendsPrecededStateWrite: boolean[];
}

/**
 * One pass of the real orchestration. `now` is carried by the report, exactly as production
 * does it (`now: new Date(report.generatedAtIso)` inside the reconcile call).
 */
async function runPass(input: {
  contentRoot: string;
  statePath: string;
  nowIso: string;
  statuses: SupervisorAgentStatus[];
  wake?: RuntimeHealthMonitorOptions['wake'];
  repeat?: boolean;
}): Promise<PassResult> {
  const mails: { subject: string; body: string }[] = [];
  const sendsPrecededStateWrite: boolean[] = [];
  const stateBeforePass = fs.existsSync(input.statePath) ? fs.readFileSync(input.statePath, 'utf8') : '';
  const chunks: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: unknown }).write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await runOpenBrainRuntimeHealthMonitor({
      statePath: input.statePath,
      contentRoot: input.contentRoot,
      socketPath: '/tmp/harness-does-not-exist.sock',
      chatId: 'chat-harness',
      agent: DESTINATION,
      operatorAgent: 'isla',
      mailDir: path.join(input.contentRoot, 'mail'),
      dryRun: false,
      repeat: input.repeat ?? false,
      checkout: { state: 'current' },
      report: cleanReport(input.nowIso),
      supervisorStatuses: input.statuses,
      restart: async () => { throw new Error('harness: delivery restart must not be reached'); },
      sendOperatorMail: async ({ subject, body }) => {
        // ORDER ASSERTION, made observable rather than asserted in a comment: if sends happen
        // before the state write, the state file cannot yet mention this pass's fingerprint.
        const onDisk = fs.existsSync(input.statePath) ? fs.readFileSync(input.statePath, 'utf8') : '';
        sendsPrecededStateWrite.push(onDisk === stateBeforePass);
        mails.push({ subject, body });
      },
      sendDiscordMessage: async () => { throw new Error('harness: no inbound class routes to the principal'); },
      wake: input.wake ?? (() => ({ ok: true, attempted: true, target: SUBJECT })),
    });
  } finally {
    (process.stdout as unknown as { write: unknown }).write = realWrite;
  }
  return { stdout: chunks.join(''), mails, sendsPrecededStateWrite };
}

/** Builds the real files reconcile and recovery read. */
function fixture(input: {
  contentRoot: string;
  queuedAt: string;
  /** omit to leave inbox_path off the expectation entirely (cause 1 of unproven consumption) */
  inboxPath?: string | null;
  /** the ids present in the inbox file; omit the message id for cause 2 (line not found) */
  inboxIds?: string[];
  /** null writes a cursor file with no lineCount (cause 3 of unproven consumption) */
  cursorLineCount?: number | null;
  messageId?: string;
}): void {
  const root = input.contentRoot;
  const messageId = input.messageId ?? 'in-1';
  const inboxFile = path.join(root, 'bridge', 'inbox', `${SUBJECT}.jsonl`);
  const ids = input.inboxIds ?? [messageId];
  writeLines(inboxFile, ids.map((id) => ({
    id,
    agentKey: SUBJECT,
    channelId: 'chat-harness',
    bindingName: SUBJECT,
    text: 'harness inbound',
  })));
  const expectation: Record<string, unknown> = {
    queued_at: input.queuedAt,
    agent: SUBJECT,
    chat_id: 'chat-harness',
    message_id: messageId,
    binding: SUBJECT,
  };
  if (input.inboxPath !== null && input.inboxPath !== undefined) expectation.inbox_path = input.inboxPath;
  writeLines(path.join(root, 'bridge', 'reconcile', 'inbound-expected.jsonl'), [expectation]);
  writeLines(path.join(root, 'bridge', 'reconcile', 'outbound-sent.jsonl'), []);
  writeJson(path.join(root, 'bridge', 'reconcile', 'reply-policy.json'), { defaultGraceMinutes: 10 });
  if (input.cursorLineCount === null) {
    writeJson(path.join(root, 'bridge', 'runtime-state', `${SUBJECT}.json`), { note: 'no lineCount field' });
  } else {
    writeJson(path.join(root, 'bridge', 'runtime-state', `${SUBJECT}.json`), {
      lineCount: input.cursorLineCount ?? 99,
    });
  }
}

function expectationsFile(contentRoot: string): string {
  return path.join(contentRoot, 'bridge', 'reconcile', 'inbound-expected.jsonl');
}

/** Appends one more expectation, leaving the replay record the recovery wrote in place. */
function appendExpectation(contentRoot: string, messageId: string, queuedAt: string): void {
  fs.appendFileSync(expectationsFile(contentRoot), JSON.stringify({
    queued_at: queuedAt,
    agent: SUBJECT,
    chat_id: 'chat-harness',
    message_id: messageId,
    binding: SUBJECT,
    inbox_path: inboxFileFor(contentRoot),
  }) + '\n');
}

function inboxFileFor(contentRoot: string): string {
  return path.join(contentRoot, 'bridge', 'inbox', `${SUBJECT}.jsonl`);
}

describe('dc-20261102-011 — runOpenBrainRuntimeHealthMonitor, multi-pass on real files', () => {
  it('(H0) the harness reaches the real orchestration and the subject is not withheld', async () => {
    const root = tempRoot();
    const statePath = path.join(root, 'state.json');
    fixture({ contentRoot: root, queuedAt: '2026-11-18T12:00:00.000Z', inboxPath: inboxFileFor(root) });

    const pass = await runPass({
      contentRoot: root,
      statePath,
      nowIso: '2026-11-18T12:30:00.000Z',
      statuses: [status('blocked')],
    });

    // NON-VACUITY: a fixture producing no finding would satisfy most assertions below by never
    // reaching them, which is the shape this file exists to avoid.
    expect(pass.stdout).toContain('inbound 1 finding(s)');
    expect(pass.stdout).not.toContain('withheld');
    expect(pass.mails).toHaveLength(1);
    expect(fs.existsSync(statePath)).toBe(true);
  });

  it('(H1) sends happen BEFORE the state write, so a crash mid-send cannot mark an unsent alert sent', async () => {
    const root = tempRoot();
    const statePath = path.join(root, 'state.json');
    fixture({ contentRoot: root, queuedAt: '2026-11-18T12:00:00.000Z', inboxPath: inboxFileFor(root) });

    const pass = await runPass({
      contentRoot: root,
      statePath,
      nowIso: '2026-11-18T12:30:00.000Z',
      statuses: [status('blocked')],
    });

    // isla's condition 3. Observed, not asserted in prose: at send time the state file still
    // holds its pre-pass bytes. Non-vacuous because H0 proves a send happens at all.
    expect(pass.sendsPrecededStateWrite).toEqual([true]);
    expect(fs.readFileSync(statePath, 'utf8')).toContain('lastInboundReplyFingerprint');
  });

  it('(H2) blocked throughout: one alert naming the block, then genuine duplicate suppression', async () => {
    const root = tempRoot();
    const statePath = path.join(root, 'state.json');
    fixture({ contentRoot: root, queuedAt: '2026-11-18T12:00:00.000Z', inboxPath: inboxFileFor(root) });

    const p1 = await runPass({ contentRoot: root, statePath, nowIso: '2026-11-18T12:30:00.000Z', statuses: [status('blocked')] });
    const p2 = await runPass({ contentRoot: root, statePath, nowIso: '2026-11-18T12:45:00.000Z', statuses: [status('blocked')] });
    const p3 = await runPass({ contentRoot: root, statePath, nowIso: '2026-11-18T13:30:00.000Z', statuses: [status('blocked')] });

    expect(p1.mails).toHaveLength(1);
    expect(p1.mails[0].body).toContain('class=consumed_blocked');
    expect(p1.mails[0].body).toContain('it will not be answered until that clears');
    // Passes 2 and 3 are past the fresh grace, so the miss is still a finding and the stored
    // fingerprint legitimately suppresses it. This is the arm that must KEEP working.
    expect(p2.mails).toHaveLength(0);
    expect(p3.mails).toHaveLength(0);
    expect(p2.stdout).toContain('duplicate alert suppressed');
    expect(p3.stdout).toContain('duplicate alert suppressed');
  });

  it('(H3) FINDING A via DEFERRAL: a pass inside the replay grace keeps the fingerprint, so one miss alerts once', async () => {
    const root = tempRoot();
    const statePath = path.join(root, 'state.json');
    fixture({ contentRoot: root, queuedAt: '2026-11-18T12:00:00.000Z', inboxPath: inboxFileFor(root) });

    const p1 = await runPass({ contentRoot: root, statePath, nowIso: '2026-11-18T12:30:00.000Z', statuses: [status('blocked')] });
    // The pass-1 recovery appended a fresh expectation carrying the SAME message_id (buildReplayEntry
    // preserves `id`), so it supersedes the original in latestInboundExpectations and the clock restarts.
    const p2 = await runPass({ contentRoot: root, statePath, nowIso: '2026-11-18T12:35:00.000Z', statuses: [status('blocked')] });
    const p3 = await runPass({ contentRoot: root, statePath, nowIso: '2026-11-18T12:50:00.000Z', statuses: [status('blocked')] });

    expect(p1.mails).toHaveLength(1);

    // The quiet window is DELIBERATE and must stay: the comment above latestInboundExpectations
    // says the replay is owed a real grace window.
    expect(p2.mails).toHaveLength(0);
    expect(p2.stdout).toContain('deferred 1');

    // FIXED (commit 3): the deferral no longer clears the dedup state, so the SAME key and class
    // are still recognised as already-reported and the second alert never goes out.
    expect(fs.readFileSync(statePath, 'utf8')).toContain('lastInboundReplyFingerprint');
    expect(p3.mails).toHaveLength(0);
    expect(p3.stdout).toContain('duplicate alert suppressed');
    expect(p1.mails[0].body).toContain('inbound=in-1');
  });

  it('(H4) FINDING A via UNDECIDABLE: blocked then idle also keeps the fingerprint', async () => {
    const root = tempRoot();
    const statePath = path.join(root, 'state.json');
    fixture({ contentRoot: root, queuedAt: '2026-11-18T12:00:00.000Z', inboxPath: inboxFileFor(root) });

    const p1 = await runPass({ contentRoot: root, statePath, nowIso: '2026-11-18T12:30:00.000Z', statuses: [status('blocked')] });
    // `consumed_idle_no_reply` is routed to `undecidable`, never to misses -- a healthy agent
    // replying interactively and a dead one produce the identical observation. So the set empties
    // for a SECOND reason that is not resolution, which a deferral-only fix would miss.
    const p2 = await runPass({ contentRoot: root, statePath, nowIso: '2026-11-18T12:50:00.000Z', statuses: [status('idle')] });
    const p3 = await runPass({ contentRoot: root, statePath, nowIso: '2026-11-18T13:10:00.000Z', statuses: [status('blocked')] });

    expect(p1.mails).toHaveLength(1);
    expect(p2.mails).toHaveLength(0);
    expect(p2.stdout).toContain('undecidable 1');
    // FIXED (commit 3): an undecidable pass is also "not judged yet", not "resolved".
    expect(fs.readFileSync(statePath, 'utf8')).toContain('lastInboundReplyFingerprint');
    expect(p3.mails).toHaveLength(0);
    expect(p3.stdout).toContain('duplicate alert suppressed');
  });

  it('(H8) a GENUINE resolution still clears the fingerprint, so a later recurrence alerts again', async () => {
    const root = tempRoot();
    const statePath = path.join(root, 'state.json');
    fixture({ contentRoot: root, queuedAt: '2026-11-18T12:00:00.000Z', inboxPath: inboxFileFor(root) });
    const outboundFile = path.join(root, 'bridge', 'reconcile', 'outbound-sent.jsonl');

    const p1 = await runPass({ contentRoot: root, statePath, nowIso: '2026-11-18T12:30:00.000Z', statuses: [status('blocked')] });
    expect(p1.mails).toHaveLength(1);

    // THE CONTROL THAT STOPS THE FIX BECOMING "ALWAYS RETAIN". A fix that simply never cleared
    // would pass H3 and H4 and silently suppress every recurrence forever, which is strictly
    // worse than the duplicate it replaced. A real reply landing is a RESOLUTION, and the
    // documented behaviour -- recovery followed by a recurrence re-alerts -- has to survive.
    writeLines(outboundFile, [{ agent: SUBJECT, chat_id: 'chat-harness', sent_at: '2026-11-18T12:40:00.000Z' }]);
    const p2 = await runPass({ contentRoot: root, statePath, nowIso: '2026-11-18T12:45:00.000Z', statuses: [status('idle')] });
    expect(p2.mails).toHaveLength(0);
    expect(p2.stdout).toContain('matched 1');
    expect(fs.readFileSync(statePath, 'utf8')).not.toContain('lastInboundReplyFingerprint');

    // The reply is withdrawn and the runtime is blocked again: a fresh incident, and it must page.
    writeLines(outboundFile, []);
    const p3 = await runPass({ contentRoot: root, statePath, nowIso: '2026-11-18T13:30:00.000Z', statuses: [status('blocked')] });
    expect(p3.mails).toHaveLength(1);
    expect(p3.mails[0].body).toContain('class=consumed_blocked');
  });

  it('(H9) coverage is compared by KEY: another key being undecided does not hold a resolved one open', async () => {
    const root = tempRoot();
    const statePath = path.join(root, 'state.json');
    fixture({ contentRoot: root, queuedAt: '2026-11-18T12:00:00.000Z', inboxPath: inboxFileFor(root) });
    const outboundFile = path.join(root, 'bridge', 'reconcile', 'outbound-sent.jsonl');

    // Pass 1: in-1 alerts, so the stored fingerprint covers in-1 and nothing else.
    const p1 = await runPass({ contentRoot: root, statePath, nowIso: '2026-11-18T12:30:00.000Z', statuses: [status('blocked')] });
    expect(p1.mails).toHaveLength(1);

    // Pass 2: in-1 is genuinely RESOLVED by a real reply, while an unrelated in-2 is inside its
    // grace window. The set is empty, but the only undecided key is one the fingerprint never
    // described, so in-1's fingerprint must still be cleared.
    //
    // THIS IS THE ONLY FIXTURE THAT CAN SEE `lastInboundReplyKeys` BEING RECORDED. Without the
    // recorded keys the code falls back to "any undecided key at all", which is indistinguishable
    // from the correct answer in every single-key fixture -- so deleting the recording survived
    // the battery until this case existed.
    writeLines(outboundFile, [{ agent: SUBJECT, chat_id: 'chat-harness', sent_at: '2026-11-18T12:40:00.000Z' }]);
    appendExpectation(root, 'in-2', '2026-11-18T12:44:00.000Z');
    const p2 = await runPass({ contentRoot: root, statePath, nowIso: '2026-11-18T12:45:00.000Z', statuses: [status('idle')] });
    expect(p2.mails).toHaveLength(0);
    expect(p2.stdout).toContain('matched 1');
    expect(p2.stdout).toContain('deferred 1');
    expect(fs.readFileSync(statePath, 'utf8')).not.toContain('lastInboundReplyFingerprint');

    // Pass 3: in-1 is a fresh incident again and must page, because its fingerprint was cleared.
    writeLines(outboundFile, []);
    appendExpectation(root, 'in-2', '2026-11-18T13:29:00.000Z');
    const p3 = await runPass({ contentRoot: root, statePath, nowIso: '2026-11-18T13:30:00.000Z', statuses: [status('blocked')] });
    expect(p3.mails).toHaveLength(1);
    expect(p3.mails[0].body).toContain('inbound=in-1');
  });

  it('(H5) FINDING B, cause 1 of 3 — no inbox_path: a BLOCKED runtime is reported as a replay, not a block', async () => {
    const root = tempRoot();
    const statePath = path.join(root, 'state.json');
    // No inbox_path on the expectation. consumptionState() cannot prove consumption, but the
    // forced replay still succeeds, because recoverInboundMiss reads a FIXED path
    // (<contentRoot>/bridge/inbox/<agent>.jsonl) rather than the expectation's inbox_path.
    fixture({ contentRoot: root, queuedAt: '2026-11-18T12:00:00.000Z', inboxPath: null });

    const p1 = await runPass({ contentRoot: root, statePath, nowIso: '2026-11-18T12:30:00.000Z', statuses: [status('blocked')] });

    // THE DEFECT: the runtime is blocked and the operator is told a replay happened and no reply
    // has been seen YET -- which reads as self-repair in progress. The remedy for the class it was
    // given is 'none'; the remedy it needed is 'restart'. Same defect class as blocker 1
    // (2026-10-12), one case over.
    expect(p1.stdout).toContain('inbound recovery recoveryNotice');
    expect(p1.mails).toHaveLength(1);
    expect(p1.mails[0].body).toContain('no reply observed yet');
    expect(p1.mails[0].body).not.toContain('blocked');
    // And the cannot-act evidence is dropped from the recorded attempt.
    expect(fs.readFileSync(statePath, 'utf8')).toContain('"cannotAct": null');
  });

  it('(H6) FINDING B, cause 2 of 3 — message id absent from the inbox: alerts, but never says the runtime cannot answer', async () => {
    const root = tempRoot();
    const statePath = path.join(root, 'state.json');
    fixture({ contentRoot: root, queuedAt: '2026-11-18T12:00:00.000Z', inboxPath: inboxFileFor(root), inboxIds: ['a-different-id'] });

    const p1 = await runPass({ contentRoot: root, statePath, nowIso: '2026-11-18T12:30:00.000Z', statuses: [status('blocked')] });

    // This cause already reaches an alert -- but INCIDENTALLY, because the replay was refused,
    // not because the block was respected. The class carries no cannot-act, so the text never
    // tells the operator the runtime will not answer.
    expect(p1.mails).toHaveLength(1);
    expect(p1.mails[0].body).toContain('class=unknown_consumption_no_reply');
    expect(p1.mails[0].body).toContain('replay refused (not_found)');
    expect(p1.mails[0].body).not.toContain('will not be answered');
  });

  it('(H7) FINDING B, cause 3 of 3 — cursor file with no lineCount: same incidental alert, same missing statement', async () => {
    const root = tempRoot();
    const statePath = path.join(root, 'state.json');
    fixture({ contentRoot: root, queuedAt: '2026-11-18T12:00:00.000Z', inboxPath: inboxFileFor(root), cursorLineCount: null });

    const p1 = await runPass({ contentRoot: root, statePath, nowIso: '2026-11-18T12:30:00.000Z', statuses: [status('blocked')] });

    expect(p1.mails).toHaveLength(1);
    expect(p1.mails[0].body).toContain('class=unknown_consumption_no_reply');
    expect(p1.mails[0].body).toContain('replay refused (not_consumed)');
    expect(p1.mails[0].body).not.toContain('will not be answered');
  });
});
