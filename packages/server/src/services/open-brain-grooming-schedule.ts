import {
  applyGroomingClassification,
  applyGroomingClusterClassification,
  classifyRawCapture,
  classifyRawCaptureCluster,
  groupRawCaptures,
  type GroomingClassification,
  type GroomingCluster,
  type GroomingClusterClassification,
  type GroomingReviewRow,
} from './open-brain-grooming-review.js';
import {
  defaultSinceIso,
  fetchRawCapturesSince,
  readDigestState,
  type GroomingDigestOptions,
  type RawCaptureRow,
} from './open-brain-grooming-digest.js';

export interface GroomingItemPlan {
  row: GroomingReviewRow;
  classification: GroomingClassification;
}

export interface GroomingClusterPlan {
  cluster: GroomingCluster;
  classification: GroomingClusterClassification;
}

export interface GroomingActionSummary {
  itemAutoIgnored: number;
  itemAutoPromotedPrivate: number;
  itemAutoPromotedProject: number;
  itemNeedsReview: number;
  clusterIgnored: number;
  clusterSkipped: number;
  clusterAutoPromotedPrivate: number;
  clusterAutoPromotedProject: number;
  clusterNeedsReview: number;
}

export interface GroomingScheduledCandidate {
  kind: 'item' | 'cluster';
  key: string;
  sourceRef: string;
  project: string;
  text: string;
  reason: string;
}

export interface GroomingScheduledResult {
  digest: string;
  rawCaptureCount: number;
  itemPlans: GroomingItemPlan[];
  clusterPlans: GroomingClusterPlan[];
  summary: GroomingActionSummary;
  reviewCandidates: GroomingScheduledCandidate[];
}

export interface GroomingScheduleOptions {
  actorAgent: string;
  sinceIso?: string;
  generatedAtIso?: string;
  limit?: number;
  maxItems?: number;
  dryRun?: boolean;
}

function compactText(text: string, maxLength: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function extractRowText(row: GroomingReviewRow): string {
  const lines = row.content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const contentLine = lines.find((line) => !line.startsWith('Raw capture candidate') && !line.startsWith('At ') && !line.startsWith('This is a candidate'));
  return contentLine ?? lines[0] ?? '';
}

function rowSourceRef(row: GroomingReviewRow): string {
  return typeof row.metadata.source_ref === 'string' ? row.metadata.source_ref : row.id;
}

function rowProject(row: GroomingReviewRow): string {
  return typeof row.metadata.project === 'string' ? row.metadata.project : 'unknown-project';
}

function rowClusterKey(row: GroomingReviewRow): string {
  const owner = typeof row.metadata.owner_agent === 'string'
    ? row.metadata.owner_agent
    : typeof row.metadata.agent_id === 'string'
      ? row.metadata.agent_id
      : 'unknown';
  const project = typeof row.metadata.project === 'string' ? row.metadata.project : 'unknown';
  const sourceType = typeof row.metadata.source_type === 'string' ? row.metadata.source_type : 'unknown';
  return [owner, project, sourceType].join('|');
}

function formatSummary(summary: GroomingActionSummary): string[] {
  return [
    `Item auto-ignored: ${summary.itemAutoIgnored}`,
    `Item auto-promoted private: ${summary.itemAutoPromotedPrivate}`,
    `Item auto-promoted project: ${summary.itemAutoPromotedProject}`,
    `Item needs review: ${summary.itemNeedsReview}`,
    `Cluster ignored: ${summary.clusterIgnored}`,
    `Cluster skipped: ${summary.clusterSkipped}`,
    `Cluster auto-promoted private: ${summary.clusterAutoPromotedPrivate}`,
    `Cluster auto-promoted project: ${summary.clusterAutoPromotedProject}`,
    `Cluster needs review: ${summary.clusterNeedsReview}`,
  ];
}

function clusterHandled(plan: GroomingClusterPlan): boolean {
  return plan.classification.action !== 'cluster_skip';
}

function itemHandledByCluster(itemPlan: GroomingItemPlan, clusterPlansByKey: Map<string, GroomingClusterPlan>): boolean {
  const clusterPlan = clusterPlansByKey.get(rowClusterKey(itemPlan.row));
  if (!clusterPlan) return false;
  return clusterHandled(clusterPlan);
}

function buildReviewCandidates(
  itemPlans: GroomingItemPlan[],
  clusterPlans: GroomingClusterPlan[],
): GroomingScheduledCandidate[] {
  const candidates: GroomingScheduledCandidate[] = [];
  const clusterPlansByKey = new Map(clusterPlans.map((plan) => [plan.cluster.key, plan] as const));

  for (const plan of itemPlans) {
    if (plan.classification.action !== 'needs_review') continue;
    if (itemHandledByCluster(plan, clusterPlansByKey)) continue;
    candidates.push({
      kind: 'item',
      key: rowSourceRef(plan.row),
      sourceRef: rowSourceRef(plan.row),
      project: rowProject(plan.row),
      text: compactText(extractRowText(plan.row), 170),
      reason: plan.classification.reason,
    });
  }

  for (const plan of clusterPlans) {
    if (plan.classification.action !== 'cluster_needs_review') continue;
    candidates.push({
      kind: 'cluster',
      key: plan.cluster.key,
      sourceRef: plan.cluster.rows.map((row) => rowSourceRef(row)).join(', '),
      project: plan.cluster.key.split('|')[1] ?? 'unknown-project',
      text: compactText(
        plan.classification.content ?? plan.cluster.rows.map((row) => extractRowText(row)).join(' | '),
        170,
      ),
      reason: plan.classification.reason,
    });
  }

  return candidates;
}

function buildExecutedSummary(
  itemPlans: GroomingItemPlan[],
  clusterPlans: GroomingClusterPlan[],
): GroomingActionSummary {
  const summary: GroomingActionSummary = {
    itemAutoIgnored: 0,
    itemAutoPromotedPrivate: 0,
    itemAutoPromotedProject: 0,
    itemNeedsReview: 0,
    clusterIgnored: 0,
    clusterSkipped: 0,
    clusterAutoPromotedPrivate: 0,
    clusterAutoPromotedProject: 0,
    clusterNeedsReview: 0,
  };

  const clusterPlansByKey = new Map(clusterPlans.map((plan) => [plan.cluster.key, plan] as const));
  for (const plan of clusterPlans) {
    if (plan.classification.action === 'cluster_ignore') summary.clusterIgnored += 1;
    else if (plan.classification.action === 'cluster_skip') summary.clusterSkipped += 1;
    else if (plan.classification.action === 'cluster_auto_promote_private') summary.clusterAutoPromotedPrivate += 1;
    else if (plan.classification.action === 'cluster_auto_promote_project') summary.clusterAutoPromotedProject += 1;
    else if (plan.classification.action === 'cluster_needs_review') summary.clusterNeedsReview += 1;
  }

  for (const plan of itemPlans) {
    if (itemHandledByCluster(plan, clusterPlansByKey)) continue;
    if (plan.classification.action === 'auto_ignore') summary.itemAutoIgnored += 1;
    else if (plan.classification.action === 'auto_promote_private') summary.itemAutoPromotedPrivate += 1;
    else if (plan.classification.action === 'auto_promote_project') summary.itemAutoPromotedProject += 1;
    else if (plan.classification.action === 'needs_review') summary.itemNeedsReview += 1;
  }

  return summary;
}

export function buildScheduledGroomingDigest(
  rows: RawCaptureRow[],
  itemPlans: GroomingItemPlan[],
  clusterPlans: GroomingClusterPlan[],
  options: GroomingDigestOptions,
  summary: GroomingActionSummary,
  reviewCandidates: GroomingScheduledCandidate[],
): string {
  const lines = [
    `OB1 memory grooming digest - ${options.generatedAtIso.slice(0, 10)}`,
    '',
    `Window: ${options.sinceIso} to ${options.generatedAtIso}`,
    `Raw captures: ${rows.length}`,
    '',
    'Action summary:',
    ...formatSummary(summary).map((line) => `- ${line}`),
  ];

  if (reviewCandidates.length > 0) {
    lines.push('');
    lines.push('Human review candidates:');
    for (const candidate of reviewCandidates.slice(0, options.maxItems ?? 12)) {
      lines.push(`- [${candidate.kind}] ${candidate.sourceRef} [${candidate.project}]: ${candidate.text}`);
      lines.push(`  Reason: ${candidate.reason}`);
    }
    if (reviewCandidates.length > (options.maxItems ?? 12)) {
      lines.push(`- ... ${reviewCandidates.length - (options.maxItems ?? 12)} more candidates omitted from this digest.`);
    }
    lines.push('');
    lines.push('Review commands:');
    lines.push('- promote <source_ref> private_agent|project|shared_team');
    lines.push('- deprecate <source_ref>');
    lines.push('- ignore <source_ref>');
  } else {
    lines.push('');
    lines.push('No human review candidates are waiting in this window.');
  }

  lines.push('');
  lines.push(options.dryRun ? 'Automated grooming actions would be applied before this digest is sent.' : 'Automated grooming actions were applied before this digest was sent.');
  return lines.join('\n');
}

export async function runScheduledGrooming(
  options: GroomingScheduleOptions,
): Promise<GroomingScheduledResult> {
  const now = new Date(options.generatedAtIso ?? new Date().toISOString());
  const generatedAtIso = options.generatedAtIso ?? now.toISOString();
  const state = readDigestState();
  const sinceIso = options.sinceIso ?? defaultSinceIso(now, state);
  const rawCaptureRows = await fetchRawCapturesSince(sinceIso, options.limit ?? 80);
  const rows = rawCaptureRows
    .map((row) => ({
      id: row.id ?? '',
      content: row.content,
      metadata: row.metadata ?? {},
    }))
    .filter((row): row is GroomingReviewRow => Boolean(row.id));

  const itemPlans: GroomingItemPlan[] = rows.map((row) => ({
    row,
    classification: classifyRawCapture(row),
  }));
  const clusterPlans: GroomingClusterPlan[] = groupRawCaptures(rows).map((cluster) => ({
    cluster,
    classification: classifyRawCaptureCluster(cluster),
  }));

  const summary = buildExecutedSummary(itemPlans, clusterPlans);
  const reviewCandidates = buildReviewCandidates(itemPlans, clusterPlans);

  if (!options.dryRun) {
    const clusterPlansByKey = new Map(clusterPlans.map((plan) => [plan.cluster.key, plan] as const));
    for (const plan of clusterPlans) {
      if (!clusterHandled(plan)) continue;
      await applyGroomingClusterClassification(plan.cluster, plan.classification, options.actorAgent);
    }
    for (const plan of itemPlans) {
      if (itemHandledByCluster(plan, clusterPlansByKey)) continue;
      await applyGroomingClassification(plan.row, plan.classification, options.actorAgent);
    }
  }

  const digest = buildScheduledGroomingDigest(
    rawCaptureRows,
    itemPlans,
    clusterPlans,
    {
      sinceIso,
      generatedAtIso,
      channelId: 'unused',
      maxItems: options.maxItems,
      dryRun: options.dryRun,
    },
    summary,
    reviewCandidates,
  );

  return {
    digest,
    rawCaptureCount: rawCaptureRows.length,
    itemPlans,
    clusterPlans,
    summary,
    reviewCandidates,
  };
}
