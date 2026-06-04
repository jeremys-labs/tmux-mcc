import {
  readDigestState,
  readLastDecisionDigest,
  type LastDecisionDigestEntry,
  type LastDecisionDigestRecord,
} from './open-brain-grooming-digest.js';
import type { GroomingScheduledCandidate } from './open-brain-grooming-schedule.js';
import {
  buildPromotedContent,
  fetchRawCaptureBySourceRef,
  isFinalGroomingStatus,
  patchThoughtMetadata,
  reviewedMetadata,
  type GroomingReviewAction,
  type GroomingReviewRow,
  type PromotionScope,
} from './open-brain-grooming-review.js';
import { callOpenBrainTool, resolveOpenBrainRuntimeConfig } from './open-brain-runtime.js';

export interface GroomingDecisionStatus {
  pendingReviewCount: number;
  lastDecisionDigestIso?: string;
  lastDigestCount: number;
  lastDigestGeneratedAtIso?: string;
}

export interface GroomingDecisionApplyOptions {
  action: GroomingReviewAction;
  selector: string;
  actorAgent: string;
  scope?: PromotionScope;
  authority?: 'source_of_truth' | 'context';
  approvedShared?: boolean;
  dryRun?: boolean;
}

export interface GroomingDecisionApplyResult {
  number: number;
  sourceRef: string;
  action: GroomingReviewAction;
  status: 'applied' | 'dry_run' | 'skipped' | 'failed';
  message: string;
}

function sourceRefsForEntry(entry: LastDecisionDigestEntry): string[] {
  return entry.sourceRef
    .split(',')
    .map((ref) => ref.trim())
    .filter(Boolean);
}

export function readGroomingDecisionStatus(): GroomingDecisionStatus {
  const state = readDigestState();
  const last = readLastDecisionDigest();
  return {
    pendingReviewCount: Array.isArray(state.pendingReviewCandidates) ? state.pendingReviewCandidates.length : 0,
    lastDecisionDigestIso: state.lastDecisionDigestIso,
    lastDigestCount: last?.count ?? 0,
    lastDigestGeneratedAtIso: last?.generatedAtIso,
  };
}

function pendingCandidateToEntry(candidate: GroomingScheduledCandidate, index: number): LastDecisionDigestEntry {
  return {
    number: index + 1,
    sourceRef: candidate.sourceRef,
    project: candidate.project,
    kind: candidate.kind,
    recommendedAction: candidate.recommendedAction,
    text: candidate.proposedMemory || candidate.text,
  };
}

export function readCurrentDecisionRecord(): LastDecisionDigestRecord | null {
  const last = readLastDecisionDigest();
  if (last) return last;
  const state = readDigestState();
  const pending = (state.pendingReviewCandidates ?? []) as GroomingScheduledCandidate[];
  if (pending.length === 0) return null;
  const generatedAtIso = state.lastDecisionDigestIso ?? new Date(0).toISOString();
  return {
    generatedAtIso,
    channelId: 'pending-state',
    count: pending.length,
    digestText: 'pending-state',
    entries: pending.map(pendingCandidateToEntry),
  };
}

export function formatGroomingDecisionStatus(status = readGroomingDecisionStatus()): string {
  return [
    'OB1 grooming decision status',
    `Pending state queue: ${status.pendingReviewCount}`,
    `Last decision digest: ${status.lastDigestGeneratedAtIso ?? 'none'}`,
    `Last digest entries: ${status.lastDigestCount}`,
    `Last decision digest sent: ${status.lastDecisionDigestIso ?? 'unknown'}`,
  ].join('\n');
}

export function formatLastDecisionDigestList(record: LastDecisionDigestRecord | null = readCurrentDecisionRecord()): string {
  if (!record) return 'No OB1 decision digest snapshot found.';
  const lines = [
    `OB1 decision digest ${record.generatedAtIso}`,
    `Entries: ${record.entries.length}`,
    '',
  ];
  for (const entry of record.entries) {
    lines.push(`#${entry.number} [${entry.kind}] ${entry.project}`);
    lines.push(`Refs: ${entry.sourceRef}`);
    lines.push(`Recommended: ${entry.recommendedAction}`);
    lines.push(`Text: ${entry.text.replace(/\s+/g, ' ').trim()}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function selectDecisionEntries(
  record: LastDecisionDigestRecord,
  selector: string,
): LastDecisionDigestEntry[] {
  const trimmed = selector.trim();
  if (!trimmed) throw new Error('Missing decision selector.');
  if (trimmed === 'all') return record.entries;

  const selected = new Set<number>();
  for (const part of trimmed.split(',')) {
    const token = part.trim();
    if (!token) continue;
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        throw new Error(`Invalid decision range: ${token}`);
      }
      for (let number = start; number <= end; number += 1) selected.add(number);
      continue;
    }
    const number = Number(token);
    if (!Number.isInteger(number) || number < 1) throw new Error(`Invalid decision number: ${token}`);
    selected.add(number);
  }

  return record.entries.filter((entry) => selected.has(entry.number));
}

function rowOwnerAgent(row: GroomingReviewRow, fallback: string): string {
  return typeof row.metadata.owner_agent === 'string'
    ? row.metadata.owner_agent
    : typeof row.metadata.agent_id === 'string'
      ? row.metadata.agent_id
      : fallback;
}

function rowProject(row: GroomingReviewRow): string {
  return typeof row.metadata.project === 'string' ? row.metadata.project : 'agent-runtime';
}

function normalizeAudience(
  rows: GroomingReviewRow[],
  ownerAgent: string,
  actorAgent: string,
  scope: PromotionScope,
): string[] {
  if (scope === 'private_agent') return [ownerAgent];
  if (scope === 'shared_team') return ['team'];
  const audience = new Set<string>([ownerAgent, actorAgent]);
  for (const row of rows) {
    const raw = row.metadata.audience;
    if (!Array.isArray(raw)) continue;
    for (const value of raw) {
      if (typeof value === 'string' && value.trim()) audience.add(value.trim());
    }
  }
  return [...audience];
}

async function fetchRowsForEntry(entry: LastDecisionDigestEntry): Promise<GroomingReviewRow[]> {
  const rows: GroomingReviewRow[] = [];
  for (const ref of sourceRefsForEntry(entry)) {
    const row = await fetchRawCaptureBySourceRef(ref);
    if (row) rows.push(row);
  }
  return rows;
}

async function applyTerminalDecision(
  entry: LastDecisionDigestEntry,
  rows: GroomingReviewRow[],
  action: 'ignore' | 'deprecate',
  actorAgent: string,
): Promise<string> {
  const status = action === 'ignore' ? 'ignored' : 'deprecated';
  for (const row of rows) {
    await patchThoughtMetadata(row.id, reviewedMetadata(row, status, actorAgent, {
      grooming_decision_digest_number: entry.number,
      grooming_decision_kind: entry.kind,
      grooming_decision_source_ref: entry.sourceRef,
    }));
  }
  return `${action}d #${entry.number} (${rows.length} raw capture${rows.length === 1 ? '' : 's'}).`;
}

async function applyPromoteDecision(
  entry: LastDecisionDigestEntry,
  rows: GroomingReviewRow[],
  options: GroomingDecisionApplyOptions,
): Promise<string> {
  if (!options.scope) throw new Error('Promote requires scope private_agent|project|shared_team.');
  if (options.scope === 'shared_team' && !options.approvedShared) {
    throw new Error('Promoting to shared_team requires approvedShared.');
  }

  const first = rows[0];
  if (!first) throw new Error(`No raw captures found for #${entry.number}.`);
  const ownerAgent = rowOwnerAgent(first, options.actorAgent);
  const config = resolveOpenBrainRuntimeConfig(ownerAgent);
  if (!config) throw new Error(`No Open Brain runtime config for owner agent ${ownerAgent}.`);
  const project = rowProject(first);
  const authority = options.authority ?? (options.scope === 'shared_team' ? 'source_of_truth' : 'context');
  const content = entry.text.trim() || rows.map((row) => buildPromotedContent(row)).join('\n\n');
  const promotionSourceRef = `grooming-decision:${entry.number}:${sourceRefsForEntry(entry).join('+')}`;

  await callOpenBrainTool(config, 'capture_agent_memory', {
    agent_id: ownerAgent,
    scope: options.scope,
    project,
    audience: normalizeAudience(rows, ownerAgent, options.actorAgent, options.scope),
    authority,
    confidence: 'medium',
    source_type: 'manual',
    source_ref: promotionSourceRef,
    approved_shared: options.approvedShared ?? false,
    content,
  });

  for (const row of rows) {
    await patchThoughtMetadata(row.id, reviewedMetadata(row, 'promoted', options.actorAgent, {
      grooming_decision_digest_number: entry.number,
      grooming_decision_kind: entry.kind,
      grooming_decision_source_ref: entry.sourceRef,
      grooming_promoted_scope: options.scope,
      grooming_promoted_authority: authority,
      grooming_promoted_source_ref: promotionSourceRef,
    }));
  }

  return `promoted #${entry.number} to ${options.scope} (${rows.length} raw capture${rows.length === 1 ? '' : 's'}).`;
}

export async function applyGroomingDecisionEntry(
  entry: LastDecisionDigestEntry,
  options: GroomingDecisionApplyOptions,
): Promise<GroomingDecisionApplyResult> {
  try {
    const rows = await fetchRowsForEntry(entry);
    if (rows.length === 0) {
      return {
        number: entry.number,
        sourceRef: entry.sourceRef,
        action: options.action,
        status: 'skipped',
        message: `No active raw captures found for #${entry.number}.`,
      };
    }
    const unresolvedRows = rows.filter((row) => !isFinalGroomingStatus(row.metadata.grooming_status));
    if (unresolvedRows.length === 0) {
      return {
        number: entry.number,
        sourceRef: entry.sourceRef,
        action: options.action,
        status: 'skipped',
        message: `#${entry.number} already resolved.`,
      };
    }
    if (options.dryRun) {
      return {
        number: entry.number,
        sourceRef: entry.sourceRef,
        action: options.action,
        status: 'dry_run',
        message: `would ${options.action} #${entry.number} (${unresolvedRows.length} raw capture${unresolvedRows.length === 1 ? '' : 's'}).`,
      };
    }

    const message = options.action === 'promote'
      ? await applyPromoteDecision(entry, unresolvedRows, options)
      : await applyTerminalDecision(entry, unresolvedRows, options.action, options.actorAgent);
    return {
      number: entry.number,
      sourceRef: entry.sourceRef,
      action: options.action,
      status: 'applied',
      message,
    };
  } catch (error) {
    return {
      number: entry.number,
      sourceRef: entry.sourceRef,
      action: options.action,
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function applyGroomingDecisionBatch(
  options: GroomingDecisionApplyOptions,
  record: LastDecisionDigestRecord | null = readCurrentDecisionRecord(),
): Promise<GroomingDecisionApplyResult[]> {
  if (!record) throw new Error('No OB1 decision digest snapshot or pending decision queue found.');
  const entries = selectDecisionEntries(record, options.selector);
  if (entries.length === 0) throw new Error(`No decision entries matched selector "${options.selector}".`);
  const results: GroomingDecisionApplyResult[] = [];
  for (const entry of entries) {
    results.push(await applyGroomingDecisionEntry(entry, options));
  }
  return results;
}
