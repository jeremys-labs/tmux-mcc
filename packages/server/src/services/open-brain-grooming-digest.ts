import fs from 'fs';
import path from 'path';
import { resolveContentRoot } from '../config.js';
import { callOpenBrainTool, resolveOpenBrainGroomingConfig } from './open-brain-runtime.js';

const DEFAULT_DISCORD_ENV_PATH = '/Volumes/Repo-Drive/agents/eli/.claude/discord/.env';
const DEFAULT_DIGEST_CHANNEL_ID = '1491979880747765810';

export interface RawCaptureRow {
  id?: string;
  created_at: string;
  content: string;
  metadata?: {
    agent_id?: string;
    owner_agent?: string;
    project?: string;
    source_ref?: string;
    source_type?: string;
    confidence?: string;
    grooming_status?: string;
    [key: string]: unknown;
  };
}

export interface GroomingDigestOptions {
  sinceIso: string;
  generatedAtIso: string;
  channelId: string;
  maxItems?: number;
  dryRun?: boolean;
}

export interface GroomingDigestState {
  lastRunIso?: string;
  classifierFailureCycles?: number;
  pendingReviewCandidates?: unknown[];
  lastDecisionDigestIso?: string;
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

function readEnvFile(filePath: string): Record<string, string> {
  return parseEnvFile(fs.readFileSync(filePath, 'utf8'));
}

export function resolveDigestStatePath(): string {
  const override = process.env.OPEN_BRAIN_GROOMING_DIGEST_STATE;
  if (override) return override;
  return path.join(resolveContentRoot(), 'open-brain', 'grooming-digest-state.json');
}

export function readDigestState(statePath = resolveDigestStatePath()): GroomingDigestState {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as GroomingDigestState;
  } catch {
    return {};
  }
}

export function writeDigestState(state: GroomingDigestState, statePath = resolveDigestStatePath()): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

// The decision digest clears `pendingReviewCandidates` the moment it sends, so the
// structured list of what was surfaced (source refs, recommended actions, scopes)
// would otherwise survive only in the Discord message. Persist a numbered snapshot
// here so a later human reply ("approve all", "promote 3", etc.) can be applied
// without re-supplying the digest text.
export interface LastDecisionDigestEntry {
  number: number;
  sourceRef: string;
  project: string;
  kind: string;
  recommendedAction: string;
  text: string;
}

export interface LastDecisionDigestRecord {
  generatedAtIso: string;
  channelId: string;
  count: number;
  digestText: string;
  entries: LastDecisionDigestEntry[];
}

export function resolveLastDecisionDigestPath(): string {
  const override = process.env.OPEN_BRAIN_LAST_DECISION_DIGEST;
  if (override) return override;
  return path.join(resolveContentRoot(), 'open-brain', 'last-decision-digest.json');
}

export function writeLastDecisionDigest(
  record: LastDecisionDigestRecord,
  filePath = resolveLastDecisionDigestPath(),
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
}

export function readLastDecisionDigest(
  filePath = resolveLastDecisionDigestPath(),
): LastDecisionDigestRecord | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as LastDecisionDigestRecord;
  } catch {
    return null;
  }
}

export function defaultSinceIso(now = new Date(), state = readDigestState()): string {
  if (state.lastRunIso) return state.lastRunIso;
  return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
}

export async function fetchRawCapturesSince(sinceIso: string, limit = 80): Promise<RawCaptureRow[]> {
  const groomingConfig = resolveOpenBrainGroomingConfig();
  if (!groomingConfig) {
    throw new Error('Open Brain grooming-bot config is missing. Set OPEN_BRAIN_GROOMING_AGENT_MEMORY_KEY.');
  }
  const result = await callOpenBrainTool(groomingConfig, 'list_agent_raw_captures', {
    agent_id: groomingConfig.agentId,
    since: sinceIso,
    limit,
  });
  const parsed = JSON.parse(result.text) as { rows?: RawCaptureRow[] };
  return parsed.rows ?? [];
}

export async function fetchRawCapturesBySourceRefs(sourceRefs: string[]): Promise<RawCaptureRow[]> {
  const refs = [...new Set(sourceRefs.map((ref) => ref.trim()).filter(Boolean))];
  if (refs.length === 0) return [];

  const groomingConfig = resolveOpenBrainGroomingConfig();
  if (!groomingConfig) {
    throw new Error('Open Brain grooming-bot config is missing. Set OPEN_BRAIN_GROOMING_AGENT_MEMORY_KEY.');
  }

  const rows: RawCaptureRow[] = [];
  for (const ref of refs) {
    const result = await callOpenBrainTool(groomingConfig, 'get_agent_raw_capture', {
      agent_id: groomingConfig.agentId,
      source_ref: ref,
    });
    const row = JSON.parse(result.text) as RawCaptureRow | null;
    if (row) rows.push(row);
  }
  return rows;
}

function compactLine(text: string, maxLength: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function extractCandidateText(row: RawCaptureRow): string {
  const lines = row.content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const contentLine = lines.find((line) => !line.startsWith('Raw capture candidate') && !line.startsWith('At ') && !line.startsWith('This is a candidate'));
  return contentLine ?? lines[0] ?? '';
}

function countBy(rows: RawCaptureRow[], keyFn: (row: RawCaptureRow) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = keyFn(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function formatCounts(counts: Map<string, number>): string {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => `${key}: ${count}`)
    .join(', ');
}

export function buildGroomingDigest(rows: RawCaptureRow[], options: GroomingDigestOptions): string {
  const limited = rows.slice(0, options.maxItems ?? 12);
  const sourceCounts = formatCounts(countBy(rows, (row) => row.metadata?.source_type ?? 'unknown'));
  const projectCounts = formatCounts(countBy(rows, (row) => row.metadata?.project ?? 'unknown'));

  const lines = [
    `OB1 memory grooming digest - ${options.generatedAtIso.slice(0, 10)}`,
    '',
    `Window: ${options.sinceIso} to ${options.generatedAtIso}`,
    `Raw captures: ${rows.length}`,
  ];

  if (rows.length > 0) {
    lines.push(`Sources: ${sourceCounts || 'none'}`);
    lines.push(`Projects: ${projectCounts || 'none'}`);
    lines.push('');
    lines.push('Review candidates:');
    for (const row of limited) {
      const sourceRef = row.metadata?.source_ref ?? 'unknown-source';
      const project = row.metadata?.project ?? 'unknown-project';
      const text = compactLine(extractCandidateText(row), 170);
      lines.push(`- ${sourceRef} [${project}]: ${text}`);
    }
    if (rows.length > limited.length) {
      lines.push(`- ... ${rows.length - limited.length} more raw captures omitted from this digest.`);
    }
    lines.push('');
    lines.push('Review commands:');
    lines.push('- promote <source_ref> private_agent|project|shared_team');
    lines.push('- deprecate <source_ref>');
    lines.push('- ignore <source_ref>');
    lines.push('');
    lines.push('No memory was promoted or deprecated automatically.');
  } else {
    lines.push('');
    lines.push('No raw captures are waiting for review in this window.');
  }

  return lines.join('\n');
}

function resolveDiscordToken(): string {
  if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN;
  const envPath = process.env.OPEN_BRAIN_GROOMING_DISCORD_ENV_PATH ?? DEFAULT_DISCORD_ENV_PATH;
  const env = readEnvFile(envPath);
  if (!env.DISCORD_BOT_TOKEN) throw new Error(`Missing DISCORD_BOT_TOKEN in ${envPath}`);
  return env.DISCORD_BOT_TOKEN;
}

export function resolveDigestChannelId(): string {
  return process.env.OPEN_BRAIN_GROOMING_DIGEST_CHANNEL_ID ?? DEFAULT_DIGEST_CHANNEL_ID;
}

function chunkDiscordMessage(text: string, maxLength = 1900): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= maxLength) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    current = line.length <= maxLength ? line : line.slice(0, maxLength);
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function sendDiscordDigest(text: string, channelId = resolveDigestChannelId()): Promise<void> {
  const token = resolveDiscordToken();
  for (const chunk of chunkDiscordMessage(text)) {
    await sendDiscordChunkWithRetry(channelId, token, chunk);
  }
}

async function sendDiscordChunkWithRetry(
  channelId: string,
  token: string,
  chunk: string,
  maxAttempts = 5,
): Promise<void> {
  let attempt = 0;
  let lastError = '';
  while (attempt < maxAttempts) {
    attempt += 1;
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: `\`\`\`text\n${chunk}\n\`\`\`` }),
    });
    const body = await response.text();
    if (response.ok) return;
    lastError = `${response.status} ${body}`;

    let delayMs = Math.min(2000 * 2 ** (attempt - 1), 15000);
    if (response.status === 429) {
      try {
        const parsed = JSON.parse(body) as { retry_after?: number };
        if (typeof parsed.retry_after === 'number' && parsed.retry_after >= 0) {
          delayMs = Math.max(Math.ceil(parsed.retry_after * 1000), 250) + 100;
        }
      } catch {
        // fall through to backoff default
      }
    } else if (response.status < 500 && response.status !== 429) {
      // non-retryable client error
      throw new Error(`Discord digest send failed: ${lastError}`);
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Discord digest send failed after ${maxAttempts} attempts: ${lastError}`);
}
