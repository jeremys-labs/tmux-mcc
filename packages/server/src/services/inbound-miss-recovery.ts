import fs from 'node:fs';
import path from 'node:path';
import {
  recordInboundExpected,
  wakeAgentRuntime,
  type RuntimeWakeResult,
} from '@agent-comms/discord-bridge';
import {
  readInboundExpected,
  readOutboundSent,
  type ReplyMiss,
  type SupervisorAgentStatus,
} from './inbound-reply-reconcile.js';
import {
  buildReplayEntry,
  decideReplay,
  findEntry,
  hasReplayOf,
  parseInboxLines,
} from './inbound-replay.js';

export interface InboundRecoveryResult {
  ok: boolean;
  action: 'wake_queued' | 'replay_consumed' | 'none';
  reason: string;
  /**
   * What the supervisor said about the runtime AT THE MOMENT OF RECOVERY, carried so the
   * notice can report what was observed instead of asserting an outcome.
   *
   * dc-20261011-006: on 2026-10-12T02:39:50Z the monitor mailed "self-healed 1 inbound
   * miss(es): eli (replay_consumed)" while eli's runtime was already blocked on a Codex
   * usage limit; the 02:49:58Z follow-up confirmed the replay produced no reply. Every step
   * had succeeded -- the message WAS replayed and the wake WAS attempted -- and the notice
   * was still false, because "self-healed" is a claim about the OUTCOME and all we had was
   * the actions. livenessFor() already computed this and the result shape dropped it.
   *
   * `null` means the supervisor had no row for the agent, which is NOT the same as healthy
   * and must not be rendered as such.
   */
  liveness: AgentRecoveryLiveness | null;
}

export interface AgentRecoveryLiveness {
  processStatus: string;
  progressStatus: string;
  /** The supervisor's own reason string, e.g. the usage-limit text. May be absent. */
  progressDetail?: string;
}

/**
 * Runtime states in which a replay CANNOT produce a reply, so no notice derived from them
 * may say the miss was healed.
 *
 * `blocked` is the state from the founding incident. `hung` and a dead process are included
 * because the false claim is identical in all three -- the message is sitting in an inbox
 * nothing is reading. Fixing only `blocked` would leave the same sentence untrue one state
 * over, which is the mistake I made on 2026-08-03 removing a boundary defect from the due
 * path and leaving it on the missed path, one function away in the same file.
 *
 * Vocabulary taken from inbound-reply-reconcile.ts, which branches on exactly these values
 * ('hung' :304, 'blocked' :311, 'idle' :318) -- not invented here.
 */
export function cannotActOn(liveness: AgentRecoveryLiveness | null): string | null {
  if (!liveness) return null;
  if (liveness.progressStatus === 'blocked') return 'blocked';
  if (liveness.progressStatus === 'hung') return 'hung';
  if (liveness.processStatus === 'dead' || liveness.processStatus === 'stopped') {
    return `process ${liveness.processStatus}`;
  }
  return null;
}

interface RecoveryDependencies {
  wake?: (agent: string) => RuntimeWakeResult;
  now?: Date;
}

function readCursor(contentRoot: string, agent: string): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(
      path.join(contentRoot, 'bridge', 'runtime-state', `${agent}.json`),
      'utf8',
    )) as { lineCount?: unknown };
    return typeof parsed.lineCount === 'number' ? parsed.lineCount : 0;
  } catch {
    return 0;
  }
}

function livenessFor(statuses: SupervisorAgentStatus[], agent: string): AgentRecoveryLiveness | null {
  const status = statuses.find((row) => row.agent === agent);
  if (!status) return null;
  return {
    processStatus: status.process?.status ?? 'unknown',
    progressStatus: status.progress?.status ?? 'unknown',
    // Carried because a notice that says "blocked" without saying WHY sends the reader
    // back to the supervisor to find out; the supervisor already told us.
    progressDetail: status.progress?.detail,
  };
}

export function recoverInboundMiss(input: {
  miss: ReplyMiss;
  contentRoot: string;
  supervisorStatuses: SupervisorAgentStatus[];
  dependencies?: RecoveryDependencies;
}): InboundRecoveryResult {
  const wake = input.dependencies?.wake ?? wakeAgentRuntime;
  const now = input.dependencies?.now ?? new Date();
  const inboxPath = path.join(input.contentRoot, 'bridge', 'inbox', `${input.miss.agent}.jsonl`);
  // Read ONCE, before any action, and attached to every return below. `liveness` is
  // required rather than optional on the result on purpose: the compiler then names every
  // path that would have omitted it (it found eight), where an optional field lets a new
  // early return silently reintroduce the unqualified "self-healed" claim.
  const liveness = livenessFor(input.supervisorStatuses, input.miss.agent);

  if (input.miss.failureClass === 'queued_not_consumed') {
    const wakeResult = wake(input.miss.agent);
    if (!wakeResult.ok) {
      return { ok: false, action: 'wake_queued', reason: `runtime wake failed: ${wakeResult.reason ?? 'unknown error'}`, liveness };
    }
    return {
      ok: true,
      action: 'wake_queued',
      reason: wakeResult.attempted ? `woke ${wakeResult.target ?? input.miss.agent}` : `wake not required (${wakeResult.reason ?? 'runtime polls inbox'})`,
      liveness,
    };
  }

  let entries: ReturnType<typeof parseInboxLines>;
  try {
    entries = parseInboxLines(fs.readFileSync(inboxPath, 'utf8'));
  } catch (error) {
    return { ok: false, action: 'none', reason: `cannot read inbox ${inboxPath}: ${String(error)}`, liveness };
  }
  const found = findEntry(entries, input.miss.inboundMessageId);
  const expected = readInboundExpected(input.contentRoot);
  const originalExpected = expected
    .filter((row) => row.agent === input.miss.agent && row.message_id === input.miss.inboundMessageId)
    .sort((a, b) => Date.parse(a.queued_at) - Date.parse(b.queued_at))[0];
  const outbound = readOutboundSent(input.contentRoot);

  // Re-read outbound receipts immediately before replay. The reconcile pass and
  // recovery are separate operations; a reply landing between them must settle
  // the miss, never be overridden into a duplicate by the force path.
  if (originalExpected && outbound.some((sent) =>
    sent.agent === input.miss.agent
    && sent.chat_id === input.miss.chatId
    && Date.parse(sent.sent_at) > Date.parse(originalExpected.queued_at))) {
    return { ok: true, action: 'none', reason: 'an outbound reply landed before recovery', liveness };
  }

  const decision = decideReplay({
    entry: found.entry,
    entryIndex: found.index,
    cursorLineCount: readCursor(input.contentRoot, input.miss.agent),
    queuedAt: originalExpected?.queued_at ?? null,
    outboundSends: outbound,
    alreadyReplayed: found.entry ? hasReplayOf(entries, found.entry.id) : false,
    liveness,
    force: true,
  });
  if (!decision.ok) {
    return { ok: false, action: 'none', reason: `replay refused (${decision.klass}): ${decision.reason}`, liveness };
  }

  const replay = buildReplayEntry(found.entry!);
  try {
    fs.appendFileSync(inboxPath, `${JSON.stringify(replay)}\n`);
  } catch (error) {
    return { ok: false, action: 'replay_consumed', reason: `replay append failed: ${String(error)}`, liveness };
  }
  recordInboundExpected(input.contentRoot, {
    queued_at: now.toISOString(),
    agent: replay.agentKey,
    chat_id: replay.channelId,
    message_id: replay.id,
    binding: String(replay.bindingName ?? replay.agentKey),
    inbox_path: inboxPath,
  });
  const wakeResult = wake(input.miss.agent);
  if (!wakeResult.ok) {
    return { ok: false, action: 'replay_consumed', reason: `message replayed but runtime wake failed: ${wakeResult.reason ?? 'unknown error'}`, liveness };
  }
  return {
    ok: true,
    action: 'replay_consumed',
    reason: wakeResult.attempted ? `message replayed and ${wakeResult.target ?? input.miss.agent} woke` : `message replayed; wake not required (${wakeResult.reason ?? 'runtime polls inbox'})`,
      liveness,
  };
}
