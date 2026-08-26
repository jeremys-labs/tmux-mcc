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

function livenessFor(statuses: SupervisorAgentStatus[], agent: string): {
  processStatus: string;
  progressStatus: string;
} | null {
  const status = statuses.find((row) => row.agent === agent);
  if (!status) return null;
  return {
    processStatus: status.process?.status ?? 'unknown',
    progressStatus: status.progress?.status ?? 'unknown',
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

  if (input.miss.failureClass === 'queued_not_consumed') {
    const wakeResult = wake(input.miss.agent);
    if (!wakeResult.ok) {
      return { ok: false, action: 'wake_queued', reason: `runtime wake failed: ${wakeResult.reason ?? 'unknown error'}` };
    }
    return {
      ok: true,
      action: 'wake_queued',
      reason: wakeResult.attempted ? `woke ${wakeResult.target ?? input.miss.agent}` : `wake not required (${wakeResult.reason ?? 'runtime polls inbox'})`,
    };
  }

  let entries: ReturnType<typeof parseInboxLines>;
  try {
    entries = parseInboxLines(fs.readFileSync(inboxPath, 'utf8'));
  } catch (error) {
    return { ok: false, action: 'none', reason: `cannot read inbox ${inboxPath}: ${String(error)}` };
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
    return { ok: true, action: 'none', reason: 'an outbound reply landed before recovery' };
  }

  const decision = decideReplay({
    entry: found.entry,
    entryIndex: found.index,
    cursorLineCount: readCursor(input.contentRoot, input.miss.agent),
    queuedAt: originalExpected?.queued_at ?? null,
    outboundSends: outbound,
    alreadyReplayed: found.entry ? hasReplayOf(entries, found.entry.id) : false,
    liveness: livenessFor(input.supervisorStatuses, input.miss.agent),
    force: true,
  });
  if (!decision.ok) {
    return { ok: false, action: 'none', reason: `replay refused (${decision.klass}): ${decision.reason}` };
  }

  const replay = buildReplayEntry(found.entry!);
  try {
    fs.appendFileSync(inboxPath, `${JSON.stringify(replay)}\n`);
  } catch (error) {
    return { ok: false, action: 'replay_consumed', reason: `replay append failed: ${String(error)}` };
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
    return { ok: false, action: 'replay_consumed', reason: `message replayed but runtime wake failed: ${wakeResult.reason ?? 'unknown error'}` };
  }
  return {
    ok: true,
    action: 'replay_consumed',
    reason: wakeResult.attempted ? `message replayed and ${wakeResult.target ?? input.miss.agent} woke` : `message replayed; wake not required (${wakeResult.reason ?? 'runtime polls inbox'})`,
  };
}
