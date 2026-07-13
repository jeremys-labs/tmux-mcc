// Inbound-message replay: the RECOVERY half of the conversational-loop
// reconciler (detection shipped 2026-07-12). When an inbound Discord message
// is consumed by a session that dies before processing it (bridge cursor
// advanced, message gone, no reply — reconciler class `consumed_runtime_dead`),
// this re-queues the original message and wakes the agent. One command turns
// an alarm into a recovery; previously this was manual tmux surgery.
//
// Correctness surface (Isla, loop R1 sign-off): replay GATES on the
// orphaned-state precondition — it must refuse unless the message is genuinely
// consumed-but-unprocessed AND the agent session is not actively processing.
// Blind re-append risks double-delivery. The decision logic is pure and
// injected-input only, so the regression fixture can reproduce the REAL 7/9
// incident state (message 1524925527146627202) without a live bridge.

export interface InboxEntryLike {
  id: string;
  agentKey: string;
  channelId: string;
  content: string;
  replayed_from?: string;
  [key: string]: unknown;
}

export interface OutboundSendLike {
  sent_at: string;
  agent: string;
  chat_id: string;
}

export interface AgentLiveness {
  processStatus: string;  // supervisor /v1/agents process.status: 'running' | 'dead' | ...
  progressStatus: string; // supervisor /v1/agents progress.status: 'processing' | 'idle' | 'unknown' | ...
}

export interface ReplayDecisionInput {
  // The target entry and its 0-based line index in the agent's inbox jsonl.
  entry: InboxEntryLike | null;
  entryIndex: number;
  // Bridge runtime-state cursor for the agent: lines consumed so far.
  cursorLineCount: number;
  // When the bridge queued the entry (inbound-expected breadcrumb). Null if
  // the breadcrumb predates the reconcile instrumentation.
  queuedAt: string | null;
  // Outbound sends by this agent to this chat (outbound-sent breadcrumbs).
  outboundSends: OutboundSendLike[];
  // True if any inbox entry already carries replayed_from === entry.id.
  alreadyReplayed: boolean;
  // Supervisor's view of the agent. Null = supervisor unreachable.
  liveness: AgentLiveness | null;
  force?: boolean;
}

export type ReplayRefusalClass =
  | 'not_found'
  | 'not_consumed'
  | 'already_answered'
  | 'already_replayed'
  | 'session_active'
  | 'liveness_unknown';

export type ReplayDecision =
  | { ok: true; forced: boolean }
  | { ok: false; klass: ReplayRefusalClass; reason: string };

export function decideReplay(input: ReplayDecisionInput): ReplayDecision {
  const { entry, entryIndex, cursorLineCount, queuedAt, outboundSends, alreadyReplayed, liveness, force } = input;

  if (!entry) {
    return { ok: false, klass: 'not_found', reason: 'no inbox entry with that message id' };
  }

  // Dedupe marker is load-bearing: a replayed entry must never be replayed
  // again by scanning for its origin. Not overridable — --force does not
  // create duplicate deliveries.
  if (alreadyReplayed) {
    return {
      ok: false,
      klass: 'already_replayed',
      reason: `message ${entry.id} was already replayed (an inbox entry carries replayed_from=${entry.id})`,
    };
  }

  // Still queued = the wrapper simply hasn't picked it up. Replaying would
  // guarantee double delivery. The right action is a wake, not a replay.
  if (entryIndex >= cursorLineCount) {
    return {
      ok: false,
      klass: 'not_consumed',
      reason: `message ${entry.id} is still queued (index ${entryIndex} >= cursor ${cursorLineCount}) — wake the agent instead of replaying`,
    };
  }

  // Answered = an outbound send by this agent to this chat after it was
  // queued. Replay would re-ask a question that got its reply.
  if (queuedAt) {
    const answered = outboundSends.some(
      (send) => send.agent === entry.agentKey && send.chat_id === entry.channelId && send.sent_at > queuedAt,
    );
    if (answered && !force) {
      return {
        ok: false,
        klass: 'already_answered',
        reason: `agent ${entry.agentKey} sent to chat ${entry.channelId} after ${queuedAt} — message appears answered (use --force to replay anyway)`,
      };
    }
  }

  // Orphaned-state gate: if the session is alive AND actively processing, the
  // message may be mid-flight right now — replay risks double delivery.
  if (liveness && liveness.processStatus === 'running' && liveness.progressStatus === 'processing' && !force) {
    return {
      ok: false,
      klass: 'session_active',
      reason: `agent ${entry.agentKey} session is running and processing — it may be handling this message; retry when idle or use --force`,
    };
  }

  // Supervisor unreachable: we cannot prove the orphaned state. Refuse unless
  // forced — a recovery tool must not guess on its correctness surface.
  if (!liveness && !force) {
    return {
      ok: false,
      klass: 'liveness_unknown',
      reason: 'supervisor unreachable — cannot verify the session is not mid-processing (use --force if you have verified manually)',
    };
  }

  return { ok: true, forced: Boolean(force) };
}

// Build the entry to re-append: identical payload, plus the dedupe marker.
// The original id is preserved so the gateway envelope the agent sees matches
// the real message; replayed_from is what keeps dedupe honest.
export function buildReplayEntry(original: InboxEntryLike): InboxEntryLike {
  return { ...original, replayed_from: original.id };
}

// Scan helpers over raw jsonl lines (torn lines skipped).
export function parseInboxLines(raw: string): InboxEntryLike[] {
  const entries: InboxEntryLike[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as InboxEntryLike);
    } catch {
      // torn/corrupt line — skip
    }
  }
  return entries;
}

export function findEntry(entries: InboxEntryLike[], messageId: string | null): { entry: InboxEntryLike | null; index: number } {
  if (messageId === null) {
    // --last: latest non-replay entry
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (!entries[i].replayed_from) return { entry: entries[i], index: i };
    }
    return { entry: null, index: -1 };
  }
  const index = entries.findIndex((e) => e.id === messageId && !e.replayed_from);
  return { entry: index === -1 ? null : entries[index], index };
}

export function hasReplayOf(entries: InboxEntryLike[], messageId: string): boolean {
  return entries.some((e) => e.replayed_from === messageId);
}
