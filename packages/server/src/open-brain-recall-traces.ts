import fs from 'fs';

const DEFAULT_TRACE_PATH = '/Volumes/Repo-Drive/agents/SHARED/open-brain-recall-traces.jsonl';

interface TraceRow {
  timestamp?: string;
  agent?: string;
  source?: string;
  lookup?: string;
  result_count?: number;
  empty?: boolean;
  error?: string;
  results?: Array<{ similarity?: number | null }>;
}

interface BucketStats {
  total: number;
  empty: number;
  errors: number;
  resultCount: number;
  topSimilarityTotal: number;
  topSimilarityCount: number;
}

function parseArgs(argv: string[]): { path: string; sinceHours: number | null } {
  let tracePath = process.env.OPEN_BRAIN_RECALL_TRACE_PATH ?? DEFAULT_TRACE_PATH;
  let sinceHours: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--path' && argv[index + 1]) tracePath = argv[++index];
    if (arg === '--since-hours' && argv[index + 1]) sinceHours = Number(argv[++index]);
  }
  return { path: tracePath, sinceHours: Number.isFinite(sinceHours) ? sinceHours : null };
}

function readRows(tracePath: string, sinceHours: number | null): TraceRow[] {
  if (!fs.existsSync(tracePath)) return [];
  const sinceMs = sinceHours === null ? null : Date.now() - sinceHours * 60 * 60 * 1000;
  return fs.readFileSync(tracePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as TraceRow;
      } catch {
        return null;
      }
    })
    .filter((row): row is TraceRow => {
      if (!row) return false;
      if (sinceMs === null) return true;
      const ts = row.timestamp ? new Date(row.timestamp).getTime() : NaN;
      return Number.isFinite(ts) && ts >= sinceMs;
    });
}

function add(stats: BucketStats, row: TraceRow): void {
  stats.total += 1;
  if (row.empty) stats.empty += 1;
  if (row.error) stats.errors += 1;
  stats.resultCount += Number(row.result_count ?? 0);
  const topSimilarity = row.results?.[0]?.similarity;
  if (typeof topSimilarity === 'number' && Number.isFinite(topSimilarity)) {
    stats.topSimilarityTotal += topSimilarity;
    stats.topSimilarityCount += 1;
  }
}

function emptyStats(): BucketStats {
  return {
    total: 0,
    empty: 0,
    errors: 0,
    resultCount: 0,
    topSimilarityTotal: 0,
    topSimilarityCount: 0,
  };
}

function percent(part: number, total: number): string {
  if (total === 0) return '0.0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

function formatStats(label: string, stats: BucketStats): string {
  const avgResults = stats.total ? (stats.resultCount / stats.total).toFixed(2) : '0.00';
  const avgTopSimilarity = stats.topSimilarityCount
    ? (stats.topSimilarityTotal / stats.topSimilarityCount).toFixed(3)
    : 'n/a';
  return [
    `${label}:`,
    `  lookups=${stats.total}`,
    `  empty=${stats.empty} (${percent(stats.empty, stats.total)})`,
    `  errors=${stats.errors} (${percent(stats.errors, stats.total)})`,
    `  avg_results=${avgResults}`,
    `  avg_top_similarity=${avgTopSimilarity}`,
  ].join('\n');
}

function grouped(rows: TraceRow[], keyFn: (row: TraceRow) => string): Map<string, BucketStats> {
  const buckets = new Map<string, BucketStats>();
  for (const row of rows) {
    const key = keyFn(row);
    const stats = buckets.get(key) ?? emptyStats();
    add(stats, row);
    buckets.set(key, stats);
  }
  return buckets;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const rows = readRows(args.path, args.sinceHours);
  const overall = emptyStats();
  for (const row of rows) add(overall, row);

  const lines = [
    '=== OB1 Recall Trace Summary ===',
    `Trace path: ${args.path}`,
    args.sinceHours === null ? 'Window: all traces' : `Window: last ${args.sinceHours} hour(s)`,
    '',
    formatStats('Overall', overall),
  ];

  for (const [label, stats] of [...grouped(rows, (row) => `${row.agent ?? 'unknown'}/${row.source ?? 'unknown'}/${row.lookup ?? 'unknown'}`)]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 12)) {
    lines.push('', formatStats(label, stats));
  }

  console.log(lines.join('\n'));
}

main();
