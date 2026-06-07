import fs from 'fs';
import { callOpenBrainTool, resolveOpenBrainGroomingConfig, resolveOpenBrainRuntimeConfig } from './open-brain-runtime.js';

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
  topic?: string;
  classifier?: Record<string, unknown>;
}

export interface GroomingCluster {
  key: string;
  rows: GroomingReviewRow[];
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

function readOpenBrainRestConfig(): { projectUrl: string; serviceKey: string } | null {
  try {
    const envPath = process.env.OPEN_BRAIN_ENV_PATH ?? DEFAULT_OPEN_BRAIN_ENV_PATH;
    const env = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
    const projectUrl = env.SUPABASE_PROJECT_URL;
    const serviceKey = env.SUPABASE_SECRET_KEY;
    return projectUrl && serviceKey ? { projectUrl, serviceKey } : null;
  } catch {
    return null;
  }
}

export interface GroomingClusterClassification {
  action: GroomingClusterAction;
  reason: string;
  scope?: PromotionScope;
  content?: string;
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

// Strip injected Open Brain answer-context / governed-memory blocks before
// classification. Their boilerplate often contains tokens like "shared_team"
// or "source_of_truth" that come from upstream memory rows, not the actual
// user/agent payload, and would otherwise misroute the classifier.
function stripInjectedContext(text: string): string {
  let stripped = text;
  stripped = stripped.replace(/<answer_context>[\s\S]*?<\/answer_context>/gi, ' ');
  stripped = stripped.replace(/<governed_memory>[\s\S]*?<\/governed_memory>/gi, ' ');
  stripped = stripped.replace(/\[Answer Context\][\s\S]*?(?=(?:<channel\b|<command-name>|$))/gi, ' ');
  stripped = stripped.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ');
  return stripped.trim();
}

function isGroomingDecisionReply(content: string): boolean {
  if (/^grooming decisions?:/i.test(content)) return true;

  const sourceRefDecisionLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:discord:\d+|agent-mail:msg_[a-z0-9]+)/i.test(line));
  if (sourceRefDecisionLines.length < 2) return false;

  const decisionTerms = /\b(ignore|agent-only memory|private_agent|private agent|project memory|shared[-_ ]team|promote|deprecate)\b/i;
  return sourceRefDecisionLines.filter((line) => decisionTerms.test(line)).length >= 2;
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

function normalizeTopicSlug(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  const slug = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
    .replace(/-$/g, '');
  return slug || '';
}

function twoHourBucket(row: GroomingReviewRow): string {
  const createdAt = metadataString(row, 'created_at');
  const date = createdAt ? new Date(createdAt) : new Date(0);
  if (Number.isNaN(date.getTime())) return 'bucket-unknown';
  date.setUTCMinutes(0, 0, 0);
  date.setUTCHours(Math.floor(date.getUTCHours() / 2) * 2);
  return `bucket-${date.toISOString().slice(0, 13)}`;
}

function rowTopic(row: GroomingReviewRow): string {
  const flatTopic = normalizeTopicSlug(row.metadata.topic);
  if (flatTopic) return flatTopic;
  const topics = row.metadata.topics;
  if (Array.isArray(topics)) {
    const firstTopic = topics.map(normalizeTopicSlug).find(Boolean);
    if (firstTopic) return firstTopic;
  }
  return twoHourBucket(row);
}

function applyClassifierPolicy(classification: GroomingClassification): GroomingClassification {
  const confidence = typeof classification.classifier?.confidence === 'number'
    ? classification.classifier.confidence
    : undefined;
  if (classification.scope === 'shared_team') {
    return { ...classification, action: 'needs_review', reason: classification.reason || 'shared/team classifier recommendation requires review' };
  }
  if (
    (classification.action === 'auto_promote_private' || classification.action === 'auto_promote_project') &&
    (confidence === undefined || confidence < 0.7)
  ) {
    return { ...classification, action: 'needs_review', reason: `classifier confidence below promotion threshold: ${classification.reason}` };
  }
  return classification;
}

export async function classifyRawCaptureWithOpenBrain(row: GroomingReviewRow): Promise<GroomingClassification> {
  const fastPath = classifyRawCapture(row);
  if (fastPath.action === 'auto_ignore' || fastPath.action === 'needs_review') return fastPath;

  const owner = ownerAgent(row);
  const config = resolveOpenBrainRuntimeConfig(owner);
  if (!config) throw new Error(`No Open Brain runtime config for owner agent ${owner}`);

  const result = await callOpenBrainTool(config, 'classify_agent_raw_capture', {
    agent_id: owner,
    content: row.content,
    metadata: row.metadata,
  });
  const parsed = JSON.parse(result.text) as {
    action?: GroomingClassificationAction;
    scope?: PromotionScope;
    confidence?: number;
    topic?: string;
    reason?: string;
    classifier?: Record<string, unknown>;
  };
  const classifier = parsed.classifier ?? {
    confidence: parsed.confidence,
    reason: parsed.reason,
  };
  return applyClassifierPolicy({
    action: parsed.action ?? 'needs_review',
    scope: parsed.scope,
    reason: parsed.reason ?? 'OB1 classifier returned no reason.',
    content: buildPromotedContent(row),
    topic: parsed.topic,
    classifier,
  });
}

export function classifyRawCapture(row: GroomingReviewRow): GroomingClassification {
  const rawContent = compactText(row.content).toLowerCase();
  const content = compactText(stripInjectedContext(row.content)).toLowerCase();
  const project = metadataString(row, 'project');
  const confidence = metadataString(row, 'confidence');
  const sourceType = metadataString(row, 'source_type');

  if (confidence === 'low') {
    return { action: 'needs_review', reason: 'low confidence capture' };
  }

  if (
    !content ||
    /^(ok|okay|thanks|thank you|great|excellent|agreed|proceed|done|yes|no)[.! ]*$/.test(content) ||
    /\b(are you online|hey buddy|still in process)\b/.test(content)
  ) {
    return { action: 'auto_ignore', reason: 'transient acknowledgement/status message' };
  }

  if (isGroomingDecisionReply(content)) {
    return {
      action: 'auto_ignore',
      reason: 'operator grooming-decision reply; decisions are applied as review metadata, not stored as durable memory',
    };
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

  if (project === 'agent-runtime' && sourceType === 'discord_reply') {
    return { action: 'auto_ignore', reason: 'outbound runtime transport capture' };
  }

  if (project === 'agent-runtime') {
    if (sourceType !== 'discord' && sourceType !== 'claude_prompt') {
      return { action: 'auto_ignore', reason: 'runtime transport/status capture' };
    }
  }

  // rawContent retained for future heuristics; reference to keep linters happy.
  void rawContent;

  return {
    action: 'auto_promote_private',
    scope: 'private_agent',
    reason: 'clear private-agent context with no shared policy signal',
    content: buildPromotedContent(row),
  };
}

function clusterKey(row: GroomingReviewRow): string {
  return [ownerAgent(row), project(row), sourceType(row), rowTopic(row)].join('|');
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
  const [agent, clusterProject, clusterSource, clusterTopic] = cluster.key.split('|');
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
    clusterTopic ? `Topic: ${clusterTopic}` : '',
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
  const groomingConfig = resolveOpenBrainGroomingConfig();
  if (!groomingConfig) {
    throw new Error('Open Brain grooming-bot config is missing. Set OPEN_BRAIN_GROOMING_AGENT_MEMORY_KEY.');
  }
  const result = await callOpenBrainTool(groomingConfig, 'get_agent_raw_capture', {
    agent_id: groomingConfig.agentId,
    source_ref: sourceRef,
  });
  return JSON.parse(result.text) as GroomingReviewRow | null;
}

export async function patchThoughtMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
  const groomingConfig = resolveOpenBrainGroomingConfig();
  if (!groomingConfig) {
    throw new Error('Open Brain grooming-bot config is missing. Set OPEN_BRAIN_GROOMING_AGENT_MEMORY_KEY.');
  }
  const sourceRef = typeof metadata.source_ref === 'string' ? metadata.source_ref : '';
  if (!sourceRef) throw new Error(`Cannot patch raw_capture ${id}: missing metadata.source_ref`);
  await callOpenBrainTool(groomingConfig, 'patch_agent_raw_capture_metadata', {
    agent_id: groomingConfig.agentId,
    source_ref: sourceRef,
    metadata_patch: metadata,
  }).catch(async (error) => {
    if (!String(error).includes('No raw_capture found')) throw error;
    const rest = readOpenBrainRestConfig();
    if (!rest) throw error;
    const url = new URL('/rest/v1/thoughts', rest.projectUrl);
    url.searchParams.set('id', `eq.${id}`);
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        apikey: rest.serviceKey,
        Authorization: `Bearer ${rest.serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ metadata }),
    });
    if (!response.ok) {
      throw new Error(`Fallback raw_capture metadata patch failed for ${sourceRef}: ${response.status} ${await response.text()}`);
    }
  });
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

export function isFinalGroomingStatus(status: unknown): boolean {
  return Boolean(status && status !== 'needs_review' && status !== 'cluster_needs_review');
}

export async function reviewRawCapture(options: GroomingReviewOptions): Promise<string> {
  const row = await fetchRawCaptureBySourceRef(options.sourceRef);
  if (!row) throw new Error(`No raw_capture found for source_ref ${options.sourceRef}`);
  if (isFinalGroomingStatus(row.metadata.grooming_status)) {
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
