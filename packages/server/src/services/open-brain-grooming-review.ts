import fs from 'fs';
import { callOpenBrainTool, resolveOpenBrainRuntimeConfig } from './open-brain-runtime.js';

const DEFAULT_OPEN_BRAIN_ENV_PATH = '/Volumes/Repo-Drive/src/open-brain/credentials/ob1.env';

export type GroomingReviewAction = 'promote' | 'deprecate' | 'ignore';
export type PromotionScope = 'private_agent' | 'project' | 'shared_team';
export type GroomingClassificationAction = 'auto_ignore' | 'auto_promote_private' | 'auto_promote_project' | 'needs_review';
export type GroomingClusterAction = 'cluster_auto_promote_private' | 'cluster_auto_promote_project' | 'cluster_needs_review' | 'cluster_ignore' | 'cluster_skip';

export interface GroomingReviewRow {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface GroomingReviewOptions {
  action: GroomingReviewAction;
  sourceRef: string;
  scope?: PromotionScope;
  actorAgent: string;
  authority?: 'source_of_truth' | 'context';
  approvedShared?: boolean;
  content?: string;
}

export interface GroomingClassification {
  action: GroomingClassificationAction;
  reason: string;
  scope?: PromotionScope;
  content?: string;
}

export interface GroomingCluster {
  key: string;
  rows: GroomingReviewRow[];
}

export interface GroomingClusterClassification {
  action: GroomingClusterAction;
  reason: string;
  scope?: PromotionScope;
  content?: string;
}

interface OpenBrainRestConfig {
  projectUrl: string;
  secretKey: string;
}

function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function resolveOpenBrainRestConfig(): OpenBrainRestConfig {
  const envPath = process.env.OPEN_BRAIN_ENV_PATH ?? DEFAULT_OPEN_BRAIN_ENV_PATH;
  const env = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  const projectUrl = env.SUPABASE_PROJECT_URL;
  const secretKey = env.SUPABASE_SECRET_KEY;
  if (!projectUrl || !secretKey) {
    throw new Error(`Missing SUPABASE_PROJECT_URL or SUPABASE_SECRET_KEY in ${envPath}`);
  }
  return { projectUrl, secretKey };
}

function restHeaders(config: OpenBrainRestConfig): Record<string, string> {
  return {
    apikey: config.secretKey,
    Authorization: `Bearer ${config.secretKey}`,
    'Content-Type': 'application/json',
  };
}

export function buildPromotedContent(row: GroomingReviewRow, override?: string): string {
  if (override?.trim()) return override.trim();
  return row.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('Raw capture candidate') && !line.startsWith('This is a candidate'))
    .join('\n')
    .trim() || row.content.trim();
}

function compactText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function metadataString(row: GroomingReviewRow, key: string): string {
  const value = row.metadata[key];
  return typeof value === 'string' ? value : '';
}

function ownerAgent(row: GroomingReviewRow): string {
  return metadataString(row, 'owner_agent') || metadataString(row, 'agent_id') || 'unknown';
}

function sourceType(row: GroomingReviewRow): string {
  return metadataString(row, 'source_type') || 'unknown';
}

function project(row: GroomingReviewRow): string {
  return metadataString(row, 'project') || 'unknown';
}

export function classifyRawCapture(row: GroomingReviewRow): GroomingClassification {
  const content = compactText(row.content).toLowerCase();
  const project = metadataString(row, 'project');
  const confidence = metadataString(row, 'confidence');
  const sourceType = metadataString(row, 'source_type');

  if (confidence === 'low') {
    return { action: 'needs_review', reason: 'low confidence capture' };
  }

  if (
    /^(ok|okay|thanks|thank you|great|excellent|agreed|proceed|done|yes|no)[.! ]*$/.test(content) ||
    /\b(are you online|hey buddy|still in process)\b/.test(content)
  ) {
    return { action: 'auto_ignore', reason: 'transient acknowledgement/status message' };
  }

  if (
    /\bsource_of_truth\b/.test(content) ||
    /\bshared[_ -]?team\b/.test(content) ||
    /\bteam truth\b/.test(content) ||
    /\bjeremy approved\b/.test(content) ||
    /\bmemory cross-contamination\b/.test(content) ||
    /\bdomain boundary\b/.test(content)
  ) {
    return { action: 'needs_review', reason: 'shared/team or policy-sensitive memory' };
  }

  if (project && project !== 'agent-runtime' && sourceType === 'agent_mail') {
    return {
      action: 'auto_promote_project',
      scope: 'project',
      reason: 'project-scoped agent-mail capture',
      content: buildPromotedContent(row),
    };
  }

  if (sourceType === 'claude_hook') {
    return { action: 'auto_ignore', reason: 'routine Claude hook heartbeat/tool telemetry' };
  }

  if (project === 'agent-runtime') {
    return { action: 'auto_ignore', reason: 'runtime transport/status capture' };
  }

  return {
    action: 'auto_promote_private',
    scope: 'private_agent',
    reason: 'clear private-agent context with no shared policy signal',
    content: buildPromotedContent(row),
  };
}

function clusterKey(row: GroomingReviewRow): string {
  return [ownerAgent(row), project(row), sourceType(row)].join('|');
}

export function groupRawCaptures(rows: GroomingReviewRow[]): GroomingCluster[] {
  const groups = new Map<string, GroomingReviewRow[]>();
  for (const row of rows) {
    const key = clusterKey(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, groupRows]) => ({ key, rows: groupRows }));
}

export function clusterSummaryContent(cluster: GroomingCluster): string {
  const [agent, clusterProject, clusterSource] = cluster.key.split('|');
  const refs = cluster.rows
    .map((row) => metadataString(row, 'source_ref'))
    .filter(Boolean)
    .join(', ');
  const points = cluster.rows
    .map((row) => buildPromotedContent(row))
    .filter(Boolean)
    .map((text) => `- ${text}`);

  return [
    `Groomed summary for ${agent} in ${clusterProject} from ${clusterSource} raw captures.`,
    refs ? `Sources: ${refs}` : '',
    ...points,
  ].filter(Boolean).join('\n');
}

export function classifyRawCaptureCluster(cluster: GroomingCluster): GroomingClusterClassification {
  if (cluster.rows.length < 3) {
    return { action: 'cluster_skip', reason: 'cluster has fewer than 3 related captures' };
  }

  const itemClassifications = cluster.rows.map(classifyRawCapture);
  const needsReview = itemClassifications.find((item) => item.action === 'needs_review');
  if (needsReview) {
    return { action: 'cluster_needs_review', reason: `contains policy-sensitive item: ${needsReview.reason}` };
  }

  if (itemClassifications.every((item) => item.action === 'auto_ignore')) {
    return { action: 'cluster_ignore', reason: 'all related captures are low-value noise' };
  }

  const [agent, clusterProject, clusterSource] = cluster.key.split('|');
  const content = clusterSummaryContent(cluster);
  if (clusterProject && clusterProject !== 'agent-runtime' && clusterSource === 'agent_mail') {
    return {
      action: 'cluster_auto_promote_project',
      scope: 'project',
      reason: `related ${clusterSource} captures form project context for ${clusterProject}`,
      content,
    };
  }

  if (agent !== 'unknown' && clusterProject !== 'agent-runtime') {
    return {
      action: 'cluster_auto_promote_private',
      scope: 'private_agent',
      reason: 'related captures form private-agent context',
      content,
    };
  }

  return { action: 'cluster_ignore', reason: 'runtime/status cluster has no durable value' };
}

export async function fetchRawCaptureBySourceRef(sourceRef: string): Promise<GroomingReviewRow | null> {
  const config = resolveOpenBrainRestConfig();
  const url = new URL('/rest/v1/thoughts', config.projectUrl);
  url.searchParams.set('select', 'id,content,metadata');
  url.searchParams.set('metadata->>scope', 'eq.raw_capture');
  url.searchParams.set('metadata->>source_ref', `eq.${sourceRef}`);
  url.searchParams.set('limit', '1');

  const response = await fetch(url, { headers: restHeaders(config) });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Open Brain raw capture lookup failed: ${response.status} ${body}`);
  }
  const rows = JSON.parse(body) as GroomingReviewRow[];
  return rows[0] ?? null;
}

export async function patchThoughtMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
  const config = resolveOpenBrainRestConfig();
  const url = new URL('/rest/v1/thoughts', config.projectUrl);
  url.searchParams.set('id', `eq.${id}`);

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      ...restHeaders(config),
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ metadata }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Open Brain metadata patch failed: ${response.status} ${body}`);
  }
}

export function reviewedMetadata(
  row: GroomingReviewRow,
  status: string,
  actorAgent: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...row.metadata,
    grooming_status: status,
    grooming_reviewed_at: new Date().toISOString(),
    grooming_reviewed_by: actorAgent,
    ...extra,
  };
}

export async function reviewRawCapture(options: GroomingReviewOptions): Promise<string> {
  const row = await fetchRawCaptureBySourceRef(options.sourceRef);
  if (!row) throw new Error(`No raw_capture found for source_ref ${options.sourceRef}`);
  if (row.metadata.grooming_status) {
    return `${options.sourceRef} already reviewed as ${String(row.metadata.grooming_status)}.`;
  }

  if (options.action === 'ignore' || options.action === 'deprecate') {
    await patchThoughtMetadata(row.id, reviewedMetadata(row, options.action === 'ignore' ? 'ignored' : 'deprecated', options.actorAgent));
    return `${options.action}d ${options.sourceRef}.`;
  }

  if (!options.scope) throw new Error('Promote requires --scope private_agent|project|shared_team');
  if (options.scope === 'shared_team' && !options.approvedShared) {
    throw new Error('Promoting to shared_team requires --approved-shared');
  }

  const ownerAgent = typeof row.metadata.owner_agent === 'string'
    ? row.metadata.owner_agent
    : typeof row.metadata.agent_id === 'string'
      ? row.metadata.agent_id
      : options.actorAgent;
  const config = resolveOpenBrainRuntimeConfig(ownerAgent);
  if (!config) throw new Error(`No Open Brain runtime config for owner agent ${ownerAgent}`);

  const authority = options.authority ?? (options.scope === 'shared_team' ? 'source_of_truth' : 'context');
  const audience = options.scope === 'shared_team'
    ? ['team']
    : options.scope === 'project'
      ? Array.from(new Set([ownerAgent, options.actorAgent, ...((Array.isArray(row.metadata.audience) ? row.metadata.audience : []) as string[])]))
      : [ownerAgent];

  await callOpenBrainTool(config, 'capture_agent_memory', {
    agent_id: ownerAgent,
    scope: options.scope,
    project: typeof row.metadata.project === 'string' ? row.metadata.project : 'agent-runtime',
    audience,
    authority,
    confidence: typeof row.metadata.confidence === 'string' ? row.metadata.confidence : 'medium',
    source_type: 'manual',
    source_ref: `grooming-promotion:${options.sourceRef}`,
    approved_shared: options.approvedShared ?? false,
    content: buildPromotedContent(row, options.content),
  });

  await patchThoughtMetadata(row.id, reviewedMetadata(row, 'promoted', options.actorAgent, {
    grooming_promoted_scope: options.scope,
    grooming_promoted_authority: authority,
    grooming_promoted_source_ref: `grooming-promotion:${options.sourceRef}`,
  }));

  return `promoted ${options.sourceRef} to ${options.scope}.`;
}

export async function applyGroomingClassification(
  row: GroomingReviewRow,
  classification: GroomingClassification,
  actorAgent: string,
): Promise<string> {
  const sourceRef = metadataString(row, 'source_ref');
  if (!sourceRef) throw new Error('Raw capture is missing metadata.source_ref');

  if (classification.action === 'needs_review') {
    await patchThoughtMetadata(row.id, reviewedMetadata(row, 'needs_review', actorAgent, {
      grooming_review_reason: classification.reason,
    }));
    return `needs_review ${sourceRef}: ${classification.reason}`;
  }

  if (classification.action === 'auto_ignore') {
    await patchThoughtMetadata(row.id, reviewedMetadata(row, 'auto_ignored', actorAgent, {
      grooming_review_reason: classification.reason,
    }));
    return `auto_ignored ${sourceRef}: ${classification.reason}`;
  }

  if (classification.action === 'auto_promote_private' || classification.action === 'auto_promote_project') {
    const scope = classification.scope ?? (classification.action === 'auto_promote_project' ? 'project' : 'private_agent');
    return reviewRawCapture({
      action: 'promote',
      sourceRef,
      scope,
      actorAgent,
      authority: 'context',
      content: classification.content,
    });
  }

  throw new Error(`Unsupported grooming classification: ${classification.action}`);
}

export async function applyGroomingClusterClassification(
  cluster: GroomingCluster,
  classification: GroomingClusterClassification,
  actorAgent: string,
): Promise<string> {
  if (classification.action === 'cluster_ignore') {
    for (const row of cluster.rows) {
      await patchThoughtMetadata(row.id, reviewedMetadata(row, 'cluster_ignored', actorAgent, {
        grooming_review_reason: classification.reason,
        grooming_cluster_key: cluster.key,
      }));
    }
    return `cluster_ignored ${cluster.key}: ${classification.reason}`;
  }

  if (classification.action === 'cluster_skip') {
    return `cluster_skipped ${cluster.key}: ${classification.reason}`;
  }

  if (classification.action === 'cluster_needs_review') {
    for (const row of cluster.rows) {
      await patchThoughtMetadata(row.id, reviewedMetadata(row, 'cluster_needs_review', actorAgent, {
        grooming_review_reason: classification.reason,
        grooming_cluster_key: cluster.key,
      }));
    }
    return `cluster_needs_review ${cluster.key}: ${classification.reason}`;
  }

  const [clusterAgent, clusterProject] = cluster.key.split('|');
  const config = resolveOpenBrainRuntimeConfig(clusterAgent);
  if (!config) throw new Error(`No Open Brain runtime config for cluster owner ${clusterAgent}`);
  const scope = classification.scope ?? (classification.action === 'cluster_auto_promote_project' ? 'project' : 'private_agent');
  const sourceRefs = cluster.rows.map((row) => metadataString(row, 'source_ref')).filter(Boolean);
  const promotionSourceRef = `grooming-cluster:${sourceRefs.join('+')}`;

  await callOpenBrainTool(config, 'capture_agent_memory', {
    agent_id: clusterAgent,
    scope,
    project: clusterProject || 'agent-runtime',
    audience: scope === 'project' ? Array.from(new Set([clusterAgent, actorAgent])) : [clusterAgent],
    authority: 'context',
    confidence: 'medium',
    source_type: 'manual',
    source_ref: promotionSourceRef,
    content: classification.content ?? clusterSummaryContent(cluster),
  });

  for (const row of cluster.rows) {
    await patchThoughtMetadata(row.id, reviewedMetadata(row, 'cluster_promoted', actorAgent, {
      grooming_review_reason: classification.reason,
      grooming_cluster_key: cluster.key,
      grooming_promoted_scope: scope,
      grooming_promoted_source_ref: promotionSourceRef,
    }));
  }

  return `cluster_promoted ${cluster.key} to ${scope}.`;
}
