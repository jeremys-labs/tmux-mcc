import fs from 'node:fs';
import {
  A2A_TERMINAL_STATES,
  appendAuditRow,
  getTask,
  readPendingRows,
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

export function readA2APollState(paths: A2APaths): PollStateMap {
  const filePath = `${paths.a2aDir}/poll-state.json`;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as PollStateMap;
  } catch {
    return {};
  }
}

export function writeA2APollState(paths: A2APaths, state: PollStateMap): void {
  fs.mkdirSync(paths.a2aDir, { recursive: true });
  fs.writeFileSync(`${paths.a2aDir}/poll-state.json`, JSON.stringify(state, null, 2));
}

export function writePendingRows(rows: A2APendingTaskRow[], paths: A2APaths): void {
  fs.mkdirSync(paths.a2aDir, { recursive: true });
  const content = rows.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(paths.pendingFile, rows.length ? `${content}\n` : '');
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

  const pending = readPendingRows(paths);
  if (!pending.length) return;

  const pollState = readA2APollState(paths);
  const now = new Date();
  const remaining: A2APendingTaskRow[] = [];

  const mailStore = options.mailStore ?? createAgentMailStore();
  const ownsMailStore = !options.mailStore;

  try {
    for (const row of pending) {
      if (now > new Date(row.expiresAt)) {
        log(`task ${row.taskId} expired (peer=${row.peer})`);
        appendAuditRow({ event: 'timeout', ts: now.toISOString(), peer: row.peer, skillId: row.skillId, fromAgent: row.fromAgent, taskId: row.taskId, project: row.project, tokenFingerprint: '' }, paths);
        deliverResult(row, 'expired', undefined, mailStore);
        delete pollState[row.id];
        continue;
      }

      const state = pollState[row.id] ?? { attempts: 0, nextPollAfter: now.toISOString() };
      if (new Date(state.nextPollAfter) > now) {
        remaining.push(row);
        continue;
      }

      let bearer: string;
      try {
        bearer = readTokenFile(row.tokenFile);
      } catch (err) {
        log(`token read error for ${row.taskId}: ${String(err)}`);
        appendAuditRow({ event: 'error', ts: now.toISOString(), peer: row.peer, skillId: row.skillId, fromAgent: row.fromAgent, taskId: row.taskId, project: row.project, tokenFingerprint: '' }, paths);
        remaining.push(row);
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
        remaining.push(row);
        continue;
      }

      appendAuditRow({ event: 'poll', ts: now.toISOString(), peer: row.peer, skillId: row.skillId, fromAgent: row.fromAgent, taskId: row.taskId, project: row.project, tokenFingerprint: fp, state: result.state, bytesIn: result.text?.length ?? 0 }, paths);
      log(`poll ${row.taskId} state=${result.state} attempts=${state.attempts + 1}`);

      if (A2A_TERMINAL_STATES.has(result.state)) {
        deliverResult(row, result.state, result.text, mailStore);
        appendAuditRow({ event: 'deliver', ts: new Date().toISOString(), peer: row.peer, skillId: row.skillId, fromAgent: row.fromAgent, taskId: row.taskId, project: row.project, tokenFingerprint: fp, state: result.state }, paths);
        delete pollState[row.id];
      } else {
        const delay = computeNextPollDelay(state.attempts + 1);
        pollState[row.id] = { attempts: state.attempts + 1, nextPollAfter: new Date(now.getTime() + delay).toISOString() };
        remaining.push(row);
      }
    }
  } finally {
    if (ownsMailStore) mailStore.close();
  }

  writePendingRows(remaining, paths);
  writeA2APollState(paths, pollState);
}
