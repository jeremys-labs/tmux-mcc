import fs from 'fs';

const DEFAULT_OPEN_BRAIN_ENV_PATH = '/Volumes/Repo-Drive/src/open-brain/credentials/ob1.env';
const DEFAULT_PAGE_SIZE = 500;

export interface MemoryAuditRow {
  importance?: number | null;
  quality_score?: number | string | null;
  sensitivity_tier?: string | null;
  enriched?: boolean | null;
  source_type?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface MemoryAuditSummary {
  total: number;
  enriched: number;
  unenriched: number;
  defaultQualityScore: number;
  defaultImportance: number;
  defaultSensitivityTier: number;
  allDefaults: number;
  scopeCounts: Map<string, number>;
  authorityCounts: Map<string, number>;
  sourceTypeCounts: Map<string, number>;
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

export function resolveOpenBrainRestConfig(): OpenBrainRestConfig {
  const envPath = process.env.OPEN_BRAIN_ENV_PATH ?? DEFAULT_OPEN_BRAIN_ENV_PATH;
  const env = readEnvFile(envPath);
  const projectUrl = env.SUPABASE_PROJECT_URL;
  const secretKey = env.SUPABASE_SECRET_KEY;
  if (!projectUrl || !secretKey) {
    throw new Error(`Missing SUPABASE_PROJECT_URL or SUPABASE_SECRET_KEY in ${envPath}`);
  }
  return { projectUrl, secretKey };
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asMetadata(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function countBy(rows: MemoryAuditRow[], getter: (row: MemoryAuditRow) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = getter(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function buildMemoryAuditSummary(rows: MemoryAuditRow[]): MemoryAuditSummary {
  let enriched = 0;
  let defaultQualityScore = 0;
  let defaultImportance = 0;
  let defaultSensitivityTier = 0;
  let allDefaults = 0;

  for (const row of rows) {
    if (row.enriched) enriched++;

    const qualityScore = normalizeNumber(row.quality_score);
    const importance = normalizeNumber(row.importance);
    const sensitivityTier = asText(row.sensitivity_tier);
    const hasDefaultQuality = qualityScore === 50;
    const hasDefaultImportance = importance === 3;
    const hasDefaultSensitivity = sensitivityTier === 'standard';

    if (hasDefaultQuality) defaultQualityScore++;
    if (hasDefaultImportance) defaultImportance++;
    if (hasDefaultSensitivity) defaultSensitivityTier++;
    if (hasDefaultQuality && hasDefaultImportance && hasDefaultSensitivity) allDefaults++;
  }

  return {
    total: rows.length,
    enriched,
    unenriched: rows.length - enriched,
    defaultQualityScore,
    defaultImportance,
    defaultSensitivityTier,
    allDefaults,
    scopeCounts: countBy(rows, (row) => asText(asMetadata(row.metadata)?.scope) || 'unknown'),
    authorityCounts: countBy(rows, (row) => asText(asMetadata(row.metadata)?.authority) || 'unknown'),
    sourceTypeCounts: countBy(rows, (row) => asText(row.source_type) || asText(asMetadata(row.metadata)?.source_type) || 'unknown'),
  };
}

function formatCounts(counts: Map<string, number>, limit = 6): string {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => `${key}: ${count}`)
    .join(', ');
}

export function formatMemoryAuditReport(summary: MemoryAuditSummary): string {
  const pct = (part: number, total: number): string => {
    if (total === 0) return '0.0';
    return ((part / total) * 100).toFixed(1);
  };

  const allDefaultsRatio = pct(summary.allDefaults, summary.total);
  const enrichedRatio = pct(summary.enriched, summary.total);

  const lines = [
    '=== OB1 Memory Audit ===',
    `Total thoughts:        ${summary.total.toLocaleString()}`,
    `Enriched:              ${summary.enriched.toLocaleString()} (${enrichedRatio}%)`,
    `Unenriched:            ${summary.unenriched.toLocaleString()} (${pct(summary.unenriched, summary.total)}%)`,
    `quality_score = 50:    ${summary.defaultQualityScore.toLocaleString()} (${pct(summary.defaultQualityScore, summary.total)}%)`,
    `importance = 3:        ${summary.defaultImportance.toLocaleString()} (${pct(summary.defaultImportance, summary.total)}%)`,
    `sensitivity = standard:${summary.defaultSensitivityTier.toLocaleString()} (${pct(summary.defaultSensitivityTier, summary.total)}%)`,
    `all three defaults:    ${summary.allDefaults.toLocaleString()} (${allDefaultsRatio}%)`,
    '',
    `Scopes:                ${formatCounts(summary.scopeCounts) || 'none'}`,
    `Authorities:           ${formatCounts(summary.authorityCounts) || 'none'}`,
    `Source types:          ${formatCounts(summary.sourceTypeCounts) || 'none'}`,
  ];

  if (summary.total > 0 && summary.allDefaults === summary.total) {
    lines.push('');
    lines.push('Status: all rows are still at the baseline metadata shape.');
    lines.push('Action: run sensitivity backfill and enrichment, then re-run the audit.');
  } else if (summary.total > 0 && summary.allDefaults / summary.total >= 0.75) {
    lines.push('');
    lines.push('Status: corpus is still mostly baseline.');
    lines.push('Action: grooming/backfill is behind ingestion.');
  } else {
    lines.push('');
    lines.push('Status: metadata is partially differentiated.');
  }

  return lines.join('\n');
}

export async function fetchAllThoughts(): Promise<MemoryAuditRow[]> {
  const config = resolveOpenBrainRestConfig();
  const rows: MemoryAuditRow[] = [];
  let offset = 0;

  while (true) {
    const url = new URL('/rest/v1/thoughts', config.projectUrl);
    url.searchParams.set('select', 'importance,quality_score,sensitivity_tier,enriched,source_type,metadata');
    url.searchParams.set('order', 'id.asc');
    url.searchParams.set('limit', String(DEFAULT_PAGE_SIZE));
    url.searchParams.set('offset', String(offset));

    const response = await fetch(url, {
      headers: {
        apikey: config.secretKey,
        Authorization: `Bearer ${config.secretKey}`,
      },
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Open Brain audit query failed: ${response.status} ${body}`);
    }

    const page = JSON.parse(body);
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    offset += page.length;
    if (page.length < DEFAULT_PAGE_SIZE) break;
  }

  return rows;
}
