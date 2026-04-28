import fs from 'fs';
import path from 'path';
import { resolveContentRoot } from '../config.js';

const DEFAULT_OPEN_BRAIN_ENV_PATH = '/Volumes/Repo-Drive/src/open-brain/credentials/ob1.env';
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
}

export interface GroomingDigestState {
  lastRunIso?: string;
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

function readEnvFile(filePath: string): Record<string, string> {
  return parseEnvFile(fs.readFileSync(filePath, 'utf8'));
}

function resolveOpenBrainRestConfig(): OpenBrainRestConfig {
  const envPath = process.env.OPEN_BRAIN_ENV_PATH ?? DEFAULT_OPEN_BRAIN_ENV_PATH;
  const env = readEnvFile(envPath);
  const projectUrl = env.SUPABASE_PROJECT_URL;
  const secretKey = env.SUPABASE_SECRET_KEY;
  if (!projectUrl || !secretKey) {
    throw new Error(`Missing SUPABASE_PROJECT_URL or SUPABASE_SECRET_KEY in ${envPath}`);
  }
  return { projectUrl, secretKey };
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

export function defaultSinceIso(now = new Date(), state = readDigestState()): string {
  if (state.lastRunIso) return state.lastRunIso;
  return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
}

export async function fetchRawCapturesSince(sinceIso: string, limit = 80): Promise<RawCaptureRow[]> {
  const config = resolveOpenBrainRestConfig();
  const url = new URL('/rest/v1/thoughts', config.projectUrl);
  url.searchParams.set('select', 'id,created_at,content,metadata');
  url.searchParams.set('metadata->>scope', 'eq.raw_capture');
  url.searchParams.set('metadata->>grooming_status', 'is.null');
  url.searchParams.set('created_at', `gte.${sinceIso}`);
  url.searchParams.set('order', 'created_at.asc');
  url.searchParams.set('limit', String(limit));

  const response = await fetch(url, {
    headers: {
      apikey: config.secretKey,
      Authorization: `Bearer ${config.secretKey}`,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Open Brain raw capture query failed: ${response.status} ${body}`);
  }
  return JSON.parse(body) as RawCaptureRow[];
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
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: `\`\`\`text\n${chunk}\n\`\`\`` }),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Discord digest send failed: ${response.status} ${body}`);
    }
  }
}
