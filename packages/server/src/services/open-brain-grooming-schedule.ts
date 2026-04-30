import {
  applyGroomingClassification,
  applyGroomingClusterClassification,
  classifyRawCapture,
  classifyRawCaptureCluster,
  clusterSummaryContent,
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
  recommendedAction: string;
  proposedMemory: string;
  evidence: string[];
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
  const contentLine = lines.find((line) => (
    !line.startsWith('Raw capture candidate') &&
    !line.startsWith('At ') &&
    !line.startsWith('Requires response:') &&
    !line.startsWith('This is a candidate')
  ));
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

function recommendedAction(kind: 'item' | 'cluster', project: string, reason: string): string {
  if (reason.includes('shared/team')) {
    return project && project !== 'agent-runtime'
      ? `Promote to project memory unless this is approved team truth; do not promote shared_team from this digest alone.`
      : `Review manually before promoting shared_team; prefer private_agent unless this is approved team truth.`;
  }

  if (project && project !== 'agent-runtime') {
    return `Promote ${kind} to project memory.`;
  }

  return `Promote to private_agent only if durable; otherwise ignore.`;
}

function candidateEvidence(rows: GroomingReviewRow[]): string[] {
  const seen = new Set<string>();
  const evidence: string[] = [];

  for (const row of rows) {
    const sourceRef = rowSourceRef(row);
    const text = compactText(extractRowText(row), 150);
    if (!text) continue;

    const line = `${sourceRef}: ${text}`;
    if (seen.has(line)) continue;
    seen.add(line);
    evidence.push(line);
  }

  return evidence.slice(0, 6);
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
      recommendedAction: recommendedAction('item', rowProject(plan.row), plan.classification.reason),
      proposedMemory: compactText(plan.classification.content ?? extractRowText(plan.row), 700),
      evidence: candidateEvidence([plan.row]),
    });
  }

  for (const plan of clusterPlans) {
    if (plan.classification.action !== 'cluster_needs_review') continue;
    const project = plan.cluster.key.split('|')[1] ?? 'unknown-project';
    const proposedMemory = plan.classification.content ?? clusterSummaryContent(plan.cluster);
    candidates.push({
      kind: 'cluster',
      key: plan.cluster.key,
      sourceRef: plan.cluster.rows.map((row) => rowSourceRef(row)).join(', '),
      project,
      text: compactText(
        proposedMemory,
        170,
      ),
      reason: plan.classification.reason,
      recommendedAction: recommendedAction('cluster', project, plan.classification.reason),
      proposedMemory: compactText(proposedMemory, 1100),
      evidence: candidateEvidence(plan.cluster.rows),
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
      lines.push(`- [${candidate.kind}] ${candidate.key} [${candidate.project}]`);
      lines.push(`  Recommended: ${candidate.recommendedAction}`);
      lines.push(`  Reason: ${candidate.reason}`);
      lines.push(`  Proposed memory: ${candidate.proposedMemory}`);
      lines.push(`  Evidence:`);
      for (const evidence of candidate.evidence) {
        lines.push(`  - ${evidence}`);
      }
      lines.push(`  Sources: ${candidate.sourceRef}`);
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
