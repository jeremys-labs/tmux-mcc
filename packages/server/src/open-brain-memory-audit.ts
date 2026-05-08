import {
  buildMemoryAuditSummary,
  fetchAllThoughts,
  formatMemoryAuditReport,
} from './services/open-brain-memory-audit.js';

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const strict = hasFlag('--strict');
  const baselineThreshold = Number(readArg('--baseline-threshold') ?? '0.75');

  const rows = await fetchAllThoughts();
  const summary = buildMemoryAuditSummary(rows);
  process.stdout.write(`${formatMemoryAuditReport(summary)}\n`);

  if (!strict) return;

  const allDefaultsRatio = summary.total > 0 ? summary.allDefaults / summary.total : 0;
  if (summary.total > 0 && allDefaultsRatio >= baselineThreshold) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
