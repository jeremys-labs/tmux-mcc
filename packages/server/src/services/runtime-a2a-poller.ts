import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  A2A_TERMINAL_STATES,
  appendAuditRow,
  getTask,
  resolveA2APaths,
  tokenFingerprint,
  readTokenFile,
  type A2AGetTaskInput,
  type A2AGetTaskResult,
  type A2APaths,
  type A2APeer,
  type A2APendingTaskRow,
  type A2ATaskState,
} from '@agent-comms/a2a-client';
import { createAgentMailStore, type AgentMailStore } from '@agent-comms/mailbox';

export interface TaskPollState {
  attempts: number;
  nextPollAfter: string;
}

export type PollStateMap = Record<string, TaskPollState>;

// Backoff schedule: 5s for early attempts, 30s mid, 2min cap
export function computeNextPollDelay(attempts: number): number {
  if (attempts < 5) return 5_000;
  if (attempts < 15) return 30_000;
  return 120_000;
}

/** Atomic write: tmp file + rename, mirroring the task-ledger helper. A crash or
 * SIGTERM mid-write can only leave an orphaned .tmp file, never a truncated
 * poll-state.json / pending.jsonl that wedges the next tick. */
function atomicWriteFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

/** Local, crash-tolerant reader for pending.jsonl. A producer crashing mid-
 * append (a2a-client's appendPendingRow) leaves a truncated trailing line;
 * skip it with a warning and process the intact rows instead of throwing and
 * wedging every pending task until a human repairs the file. */
export function readPendingRowsResilient(paths: A2APaths, log: (line: string) => void): A2APendingTaskRow[] {
  if (!fs.existsSync(paths.pendingFile)) return [];
  const rows: A2APendingTaskRow[] = [];
  for (const line of fs.readFileSync(paths.pendingFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as A2APendingTaskRow);
    } catch {
      log(`skipping malformed pending row: ${line.slice(0, 120)}`);
    }
  }
  return rows;
}

function deliveredFilePath(paths: A2APaths): string {
  return path.join(paths.a2aDir, 'delivered.jsonl');
}

/** Durable set of taskIds already delivered, so a crash between mail send and
 * pending cleanup doesn't re-deliver the same result on the next tick. */
function readDeliveredIds(paths: A2APaths): Set<string> {
  const ids = new Set<string>();
  const file = deliveredFilePath(paths);
  if (!fs.existsSync(file)) return ids;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      ids.add((JSON.parse(line) as { taskId: string }).taskId);
    } catch {
      // ignore a torn trailing marker line
    }
  }
  return ids;
}

function recordDelivered(taskId: string, paths: A2APaths): void {
  fs.mkdirSync(paths.a2aDir, { recursive: true });
  fs.appendFileSync(deliveredFilePath(paths), `${JSON.stringify({ taskId, ts: new Date().toISOString() })}\n`);
}

export function readA2APollState(paths: A2APaths): PollStateMap {
  const filePath = `${paths.a2aDir}/poll-state.json`;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as PollStateMap;
  } catch {
    return {};
  }
}

export function writeA2APollState(paths: A2APaths, state: PollStateMap): void {
  atomicWriteFile(`${paths.a2aDir}/poll-state.json`, JSON.stringify(state, null, 2));
}

export function writePendingRows(rows: A2APendingTaskRow[], paths: A2APaths): void {
  const content = rows.map((r) => JSON.stringify(r)).join('\n');
  atomicWriteFile(paths.pendingFile, rows.length ? `${content}\n` : '');
}

function peerFromRow(row: A2APendingTaskRow): A2APeer {
  return {
    key: row.peer,
    label: row.peer,
    baseUrl: row.baseUrl,
    endpointPath: row.endpointPath,
    tokenFile: row.tokenFile,
  };
}

function deliverResult(
  row: A2APendingTaskRow,
  state: A2ATaskState | 'expired',
  resultText: string | undefined,
  mailStore: AgentMailStore,
): void {
  const isSuccess = state === 'completed';
  const statusLine = isSuccess ? `Task completed.` : `Task ended with state: ${state}.`;

  let bodyMd = `${statusLine}\n\nPeer: ${row.peer}\nSkill: ${row.skillId}\nTask ID: ${row.taskId}`;
  const sharePayload = row.project !== 'private' && resultText;
  if (sharePayload) {
    bodyMd += `\n\n---\n\n${resultText}`;
  } else if (resultText) {
    bodyMd += `\n\n(payload omitted — project=private; length: ${resultText.length} chars)`;
  }

  mailStore.send({
    fromAgent: `a2a:${row.peer}`,
    toAgent: row.fromAgent,
    type: 'note',
    subject: row.callbackSubject ?? `[A2A] ${row.peer}/${row.skillId} result for task ${row.taskId}`,
    bodyMd,
    relatedProject: row.project !== 'private' ? row.project : undefined,
    correlationId: row.correlationId,
  });
}

export interface RunA2APollerTickOptions {
  /** Override resolved via MCC_TMUX_HOME; primarily used in tests. */
  paths?: A2APaths;
  mailStore?: AgentMailStore;
  logPath?: string;
  /** Override for test seam — replaces the real getTask HTTP call. */
  getTaskImpl?: (input: A2AGetTaskInput) => Promise<A2AGetTaskResult>;
}

export async function runA2APollerTick(options: RunA2APollerTickOptions = {}): Promise<void> {
  const {
    paths = resolveA2APaths(),
    logPath,
    getTaskImpl = getTask,
  } = options;

  const log = (line: string) => {
    if (logPath) fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  };

  const pending = readPendingRowsResilient(paths, log);
  if (!pending.length) return;

  const pollState = readA2APollState(paths);
  const delivered = readDeliveredIds(paths);
  const now = new Date();
  // ids finished this tick (delivered terminal or expired) — the only rows we
  // remove from pending. Everything else is left in place so a concurrent
  // append is never erased.
  const handledIds = new Set<string>();

  const mailStore = options.mailStore ?? createAgentMailStore();
  const ownsMailStore = !options.mailStore;

  try {
    for (const row of pending) {
      // Idempotency: a prior tick may have delivered this task but crashed
      // before pruning pending.jsonl. The durable marker lets us drop the row
      // without re-sending the result.
      if (delivered.has(row.taskId)) {
        log(`task ${row.taskId} already delivered; dropping stale pending row`);
        handledIds.add(row.id);
        delete pollState[row.id];
        continue;
      }

      if (now > new Date(row.expiresAt)) {
        log(`task ${row.taskId} expired (peer=${row.peer})`);
        appendAuditRow({ event: 'timeout', ts: now.toISOString(), peer: row.peer, skillId: row.skillId, fromAgent: row.fromAgent, taskId: row.taskId, project: row.project, tokenFingerprint: '' }, paths);
        recordDelivered(row.taskId, paths);
        deliverResult(row, 'expired', undefined, mailStore);
        handledIds.add(row.id);
        delete pollState[row.id];
        continue;
      }

      const state = pollState[row.id] ?? { attempts: 0, nextPollAfter: now.toISOString() };
      if (new Date(state.nextPollAfter) > now) {
        continue;
      }

      let bearer: string;
      try {
        bearer = readTokenFile(row.tokenFile);
      } catch (err) {
        log(`token read error for ${row.taskId}: ${String(err)}`);
        appendAuditRow({ event: 'error', ts: now.toISOString(), peer: row.peer, skillId: row.skillId, fromAgent: row.fromAgent, taskId: row.taskId, project: row.project, tokenFingerprint: '' }, paths);
        continue;
      }

      const fp = tokenFingerprint(bearer);
      let result: A2AGetTaskResult;

      try {
        result = await getTaskImpl({ peer: peerFromRow(row), taskId: row.taskId, token: bearer });
      } catch (err) {
        log(`poll error ${row.taskId} attempt=${state.attempts + 1}: ${String(err)}`);
        appendAuditRow({ event: 'error', ts: now.toISOString(), peer: row.peer, skillId: row.skillId, fromAgent: row.fromAgent, taskId: row.taskId, project: row.project, tokenFingerprint: fp }, paths);
        const delay = computeNextPollDelay(state.attempts + 1);
        pollState[row.id] = { attempts: state.attempts + 1, nextPollAfter: new Date(now.getTime() + delay).toISOString() };
        continue;
      }

      appendAuditRow({ event: 'poll', ts: now.toISOString(), peer: row.peer, skillId: row.skillId, fromAgent: row.fromAgent, taskId: row.taskId, project: row.project, tokenFingerprint: fp, state: result.state, bytesIn: result.text?.length ?? 0 }, paths);
      log(`poll ${row.taskId} state=${result.state} attempts=${state.attempts + 1}`);

      if (A2A_TERMINAL_STATES.has(result.state)) {
        // Durable delivered-marker before the pending prune (and before the row
        // is considered handled) so a crash here can't silently re-deliver.
        recordDelivered(row.taskId, paths);
        deliverResult(row, result.state, result.text, mailStore);
        appendAuditRow({ event: 'deliver', ts: new Date().toISOString(), peer: row.peer, skillId: row.skillId, fromAgent: row.fromAgent, taskId: row.taskId, project: row.project, tokenFingerprint: fp, state: result.state }, paths);
        handledIds.add(row.id);
        delete pollState[row.id];
      } else {
        const delay = computeNextPollDelay(state.attempts + 1);
        pollState[row.id] = { attempts: state.attempts + 1, nextPollAfter: new Date(now.getTime() + delay).toISOString() };
      }
    }
  } finally {
    if (ownsMailStore) mailStore.close();
  }

  // Append-only reconcile: re-read pending fresh so any row a producer appended
  // during the (up to 2-min) poll window survives, and remove only the ids we
  // finished. Replaces the blind full-rewrite that erased concurrent appends.
  const survivors = readPendingRowsResilient(paths, log).filter((r) => !handledIds.has(r.id));
  writePendingRows(survivors, paths);

  // Prune orphaned pollState keys — rows that vanished non-terminally (handled,
  // expired, or externally removed) would otherwise leak state forever (L1).
  const liveIds = new Set(survivors.map((r) => r.id));
  for (const key of Object.keys(pollState)) {
    if (!liveIds.has(key)) delete pollState[key];
  }
  writeA2APollState(paths, pollState);
}
