import {
  applyGroomingClassification,
  classifyRawCapture,
  fetchRawCaptureBySourceRef,
  type GroomingReviewRow,
} from './services/open-brain-grooming-review.js';
import { fetchRawCapturesSince, readDigestState, defaultSinceIso } from './services/open-brain-grooming-digest.js';

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function toReviewRow(row: { id?: string; content: string; metadata?: Record<string, unknown> }): GroomingReviewRow | null {
  if (!row.id) return null;
  return {
    id: row.id,
    content: row.content,
    metadata: row.metadata ?? {},
  };
}

async function main(): Promise<void> {
  const actor = readArg('--actor') ?? 'eli';
  const sourceRef = readArg('--source-ref');
  const dryRun = hasFlag('--dry-run');

  const rows = sourceRef
    ? [await fetchRawCaptureBySourceRef(sourceRef)].filter((row): row is GroomingReviewRow => row !== null)
    : (await fetchRawCapturesSince(readArg('--since') ?? defaultSinceIso(new Date(), readDigestState()), Number(readArg('--limit') ?? '80')))
      .map(toReviewRow)
      .filter((row): row is GroomingReviewRow => row !== null);

  const results: string[] = [];
  for (const row of rows) {
    const classification = classifyRawCapture(row);
    const ref = typeof row.metadata.source_ref === 'string' ? row.metadata.source_ref : row.id;
    if (dryRun) {
      results.push(`${classification.action} ${ref}: ${classification.reason}`);
      continue;
    }
    results.push(await applyGroomingClassification(row, classification, actor));
  }

  process.stdout.write(`${results.join('\n')}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
