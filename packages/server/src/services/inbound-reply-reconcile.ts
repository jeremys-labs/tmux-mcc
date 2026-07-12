import fs from 'fs';
import path from 'path';

export interface InboundExpectedRecord {
  queued_at: string;
  agent: string;
  chat_id: string;
  message_id: string;
  binding: string;
  inbox_path?: string;
}

export interface OutboundSentRecord {
  sent_at: string;
  agent: string;
  chat_id: string;
  message_id: string;
  binding: string;
}

export interface AgentReplyPolicy {
  graceMinutes?: number;
  optOut?: boolean;
  optOutChatIds?: string[];
}

export interface ReplyReconcilePolicy {
  defaultGraceMinutes?: number;
  agents?: Record<string, AgentReplyPolicy>;
}

export interface SupervisorAgentStatus {
  agent: string;
  process?: {
    status?: string;
    pid?: number;
  };
  progress?: {
    status?: string;
    detail?: string;
  };
}

export type ReplyMissClass =
  | 'queued_not_consumed'
  | 'consumed_runtime_dead'
  | 'consumed_hung'
  | 'consumed_blocked'
  | 'consumed_idle_no_reply'
  | 'consumed_unknown_no_reply'
  | 'unknown_consumption_no_reply';

export interface ReplyMiss {
  key: string;
  agent: string;
  chatId: string;
  inboundMessageId: string;
  queuedAt: string;
  ageMinutes: number;
  graceMinutes: number;
  failureClass: ReplyMissClass;
  detail: string;
}

export interface ReplyReconcileResult {
  checkedAtIso: string;
  expectedCount: number;
  matchedCount: number;
  deferredCount: number;
  skippedCount: number;
  misses: ReplyMiss[];
}

interface InboxLineIndex {
  lineIndexByMessageId: Map<string, number>;
}

const DEFAULT_GRACE_MINUTES = 10;

function parseIso(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function minutesBetween(now: Date, iso: string): number {
  const ts = parseIso(iso);
  if (ts === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((now.getTime() - ts) / 60_000));
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readJsonl<T>(filePath: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const records: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as T);
    } catch {
      // Skip torn writes; the bridge writes append-only JSONL.
    }
  }
  return records;
}

export function inboundExpectedPath(contentRoot: string): string {
  return path.join(contentRoot, 'bridge', 'reconcile', 'inbound-expected.jsonl');
}

export function outboundSentPath(contentRoot: string): string {
  return path.join(contentRoot, 'bridge', 'reconcile', 'outbound-sent.jsonl');
}

export function replyPolicyPath(contentRoot: string): string {
  return path.join(contentRoot, 'bridge', 'reconcile', 'reply-policy.json');
}

export function readInboundExpected(contentRoot: string): InboundExpectedRecord[] {
  return readJsonl<InboundExpectedRecord>(inboundExpectedPath(contentRoot));
}

export function readOutboundSent(contentRoot: string): OutboundSentRecord[] {
  return readJsonl<OutboundSentRecord>(outboundSentPath(contentRoot));
}

export function readReplyPolicy(contentRoot: string): ReplyReconcilePolicy {
  return readJsonFile<ReplyReconcilePolicy>(replyPolicyPath(contentRoot)) ?? {};
}

function runtimeCursorPath(contentRoot: string, agent: string): string {
  return path.join(contentRoot, 'bridge', 'runtime-state', `${agent}.json`);
}

function readRuntimeCursor(contentRoot: string, agent: string): number | null {
  const parsed = readJsonFile<{ lineCount?: unknown }>(runtimeCursorPath(contentRoot, agent));
  return typeof parsed?.lineCount === 'number' ? parsed.lineCount : null;
}

function readInboxLineIndex(inboxPath: string): InboxLineIndex {
  const lineIndexByMessageId = new Map<string, number>();
  let raw: string;
  try {
    raw = fs.readFileSync(inboxPath, 'utf8');
  } catch {
    return { lineIndexByMessageId };
  }

  raw.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as { id?: unknown };
      if (typeof parsed.id === 'string') lineIndexByMessageId.set(parsed.id, index);
    } catch {
      // Ignore torn/corrupt historical inbox lines.
    }
  });
  return { lineIndexByMessageId };
}

function isOptedOut(record: InboundExpectedRecord, policy: ReplyReconcilePolicy): boolean {
  const agentPolicy = policy.agents?.[record.agent];
  if (!agentPolicy) return false;
  if (agentPolicy.optOut) return true;
  return agentPolicy.optOutChatIds?.includes(record.chat_id) ?? false;
}

function graceMinutes(record: InboundExpectedRecord, policy: ReplyReconcilePolicy): number {
  const agentGrace = policy.agents?.[record.agent]?.graceMinutes;
  const defaultGrace = policy.defaultGraceMinutes;
  const value = agentGrace ?? defaultGrace ?? DEFAULT_GRACE_MINUTES;
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_GRACE_MINUTES;
}

function hasReply(record: InboundExpectedRecord, outbound: OutboundSentRecord[]): boolean {
  const queuedAt = parseIso(record.queued_at);
  if (queuedAt === null) return false;
  return outbound.some((sent) => {
    if (sent.agent !== record.agent || sent.chat_id !== record.chat_id) return false;
    const sentAt = parseIso(sent.sent_at);
    return sentAt !== null && sentAt > queuedAt;
  });
}

function statusForAgent(statuses: SupervisorAgentStatus[], agent: string): SupervisorAgentStatus | undefined {
  return statuses.find((status) => status.agent === agent);
}

function consumptionState(input: {
  record: InboundExpectedRecord;
  contentRoot: string;
  inboxCache: Map<string, InboxLineIndex>;
}): 'queued' | 'consumed' | 'unknown' {
  const { record, contentRoot, inboxCache } = input;
  if (!record.inbox_path) return 'unknown';
  let index = inboxCache.get(record.inbox_path);
  if (!index) {
    index = readInboxLineIndex(record.inbox_path);
    inboxCache.set(record.inbox_path, index);
  }
  const lineIndex = index.lineIndexByMessageId.get(record.message_id);
  if (lineIndex === undefined) return 'unknown';
  const cursor = readRuntimeCursor(contentRoot, record.agent);
  if (cursor === null) return 'unknown';
  return cursor > lineIndex ? 'consumed' : 'queued';
}

function classifyMiss(input: {
  record: InboundExpectedRecord;
  contentRoot: string;
  status?: SupervisorAgentStatus;
  inboxCache: Map<string, InboxLineIndex>;
}): { failureClass?: ReplyMissClass; detail: string; deferred: boolean } {
  const { record, contentRoot, status, inboxCache } = input;
  const consumed = consumptionState({ record, contentRoot, inboxCache });
  const processStatus = status?.process?.status;
  const progressStatus = status?.progress?.status;
  const progressDetail = status?.progress?.detail;
  const stateDetail = `supervisor process=${processStatus ?? 'unknown'} progress=${progressStatus ?? 'unknown'}${progressDetail ? ` (${progressDetail})` : ''}`;

  if (consumed === 'queued') {
    return {
      failureClass: 'queued_not_consumed',
      detail: `inbound queued but runtime cursor has not consumed it; ${stateDetail}`,
      deferred: false,
    };
  }

  if (processStatus === 'running' && progressStatus === 'processing') {
    return {
      detail: `runtime is actively processing; deferring no-reply alarm; ${stateDetail}`,
      deferred: true,
    };
  }

  if (consumed === 'unknown') {
    return {
      failureClass: 'unknown_consumption_no_reply',
      detail: `no outbound reply and consumption could not be proven; ${stateDetail}`,
      deferred: false,
    };
  }

  if (processStatus === 'dead') {
    return {
      failureClass: 'consumed_runtime_dead',
      detail: `inbound was consumed, then runtime is dead; ${stateDetail}`,
      deferred: false,
    };
  }
  if (progressStatus === 'hung') {
    return {
      failureClass: 'consumed_hung',
      detail: `inbound was consumed, no reply sent, runtime appears hung; ${stateDetail}`,
      deferred: false,
    };
  }
  if (progressStatus === 'blocked') {
    return {
      failureClass: 'consumed_blocked',
      detail: `inbound was consumed, no reply sent, runtime is blocked; ${stateDetail}`,
      deferred: false,
    };
  }
  if (progressStatus === 'idle') {
    return {
      failureClass: 'consumed_idle_no_reply',
      detail: `inbound was consumed, runtime is idle, but no reply was sent; ${stateDetail}`,
      deferred: false,
    };
  }
  return {
    failureClass: 'consumed_unknown_no_reply',
    detail: `inbound was consumed, no reply sent, runtime state is unclear; ${stateDetail}`,
    deferred: false,
  };
}

export function reconcileInboundReplies(input: {
  expected: InboundExpectedRecord[];
  outbound: OutboundSentRecord[];
  policy?: ReplyReconcilePolicy;
  supervisorStatuses?: SupervisorAgentStatus[];
  contentRoot: string;
  now?: Date;
}): ReplyReconcileResult {
  const now = input.now ?? new Date();
  const policy = input.policy ?? {};
  const supervisorStatuses = input.supervisorStatuses ?? [];
  const inboxCache = new Map<string, InboxLineIndex>();
  let matchedCount = 0;
  let skippedCount = 0;
  let deferredCount = 0;
  const misses: ReplyMiss[] = [];

  for (const record of input.expected) {
    if (isOptedOut(record, policy)) {
      skippedCount += 1;
      continue;
    }
    if (hasReply(record, input.outbound)) {
      matchedCount += 1;
      continue;
    }
    const ageMinutes = minutesBetween(now, record.queued_at);
    const grace = graceMinutes(record, policy);
    if (ageMinutes < grace) {
      deferredCount += 1;
      continue;
    }

    const classified = classifyMiss({
      record,
      contentRoot: input.contentRoot,
      status: statusForAgent(supervisorStatuses, record.agent),
      inboxCache,
    });
    if (classified.deferred || !classified.failureClass) {
      deferredCount += 1;
      continue;
    }

    misses.push({
      key: `${record.agent}:${record.chat_id}:${record.message_id}`,
      agent: record.agent,
      chatId: record.chat_id,
      inboundMessageId: record.message_id,
      queuedAt: record.queued_at,
      ageMinutes,
      graceMinutes: grace,
      failureClass: classified.failureClass,
      detail: classified.detail,
    });
  }

  return {
    checkedAtIso: now.toISOString(),
    expectedCount: input.expected.length,
    matchedCount,
    deferredCount,
    skippedCount,
    misses,
  };
}

export function formatInboundReplyMissAlert(result: ReplyReconcileResult): string {
  const lines = [
    `Inbound reply reconciliation failed at ${result.checkedAtIso}.`,
    '',
    'Discord messages were queued for agents but no successful outbound reply was observed within policy.',
    '',
    ...result.misses.slice(0, 10).map((miss) =>
      `- ${miss.agent} chat=${miss.chatId} inbound=${miss.inboundMessageId} age=${miss.ageMinutes}m grace=${miss.graceMinutes}m class=${miss.failureClass}: ${miss.detail}`),
  ];
  if (result.misses.length > 10) lines.push(`- ...and ${result.misses.length - 10} more inbound reply miss(es).`);
  lines.push('');
  lines.push('Action: inspect the affected runtime pane before assuming the user received a reply.');
  return lines.join('\n');
}

export function inboundReplyMissFingerprint(misses: ReplyMiss[]): string {
  return misses
    .map((miss) => `${miss.key}:${miss.failureClass}`)
    .sort()
    .join('|');
}
