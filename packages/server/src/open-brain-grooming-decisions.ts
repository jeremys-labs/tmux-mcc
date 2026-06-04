import {
  applyGroomingDecisionBatch,
  formatGroomingDecisionStatus,
  formatLastDecisionDigestList,
  type GroomingDecisionApplyResult,
} from './services/open-brain-grooming-decisions.js';
import type { GroomingReviewAction, PromotionScope } from './services/open-brain-grooming-review.js';

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function parseAction(raw?: string): GroomingReviewAction {
  if (raw === 'promote' || raw === 'deprecate' || raw === 'ignore') return raw;
  throw new Error('Usage: open-brain:grooming-decisions --list | --status | --apply <numbers|ranges|all> --action promote|deprecate|ignore [--scope private_agent|project|shared_team]');
}

function parseScope(raw?: string): PromotionScope | undefined {
  if (!raw) return undefined;
  if (raw === 'private_agent' || raw === 'project' || raw === 'shared_team') return raw;
  throw new Error(`Invalid scope: ${raw}`);
}

function formatResults(results: GroomingDecisionApplyResult[]): string {
  return results
    .map((result) => `#${result.number} ${result.status}: ${result.message}`)
    .join('\n');
}

async function main(): Promise<void> {
  if (hasFlag('--status')) {
    process.stdout.write(`${formatGroomingDecisionStatus()}\n`);
    return;
  }

  if (hasFlag('--list')) {
    process.stdout.write(`${formatLastDecisionDigestList()}\n`);
    return;
  }

  const selector = readArg('--apply');
  if (!selector) {
    throw new Error('Usage: open-brain:grooming-decisions --list | --status | --apply <numbers|ranges|all> --action promote|deprecate|ignore [--scope private_agent|project|shared_team]');
  }

  const results = await applyGroomingDecisionBatch({
    selector,
    action: parseAction(readArg('--action')),
    scope: parseScope(readArg('--scope')),
    actorAgent: readArg('--actor') ?? 'eli',
    authority: readArg('--authority') as 'source_of_truth' | 'context' | undefined,
    approvedShared: hasFlag('--approved-shared'),
    dryRun: hasFlag('--dry-run'),
  });
  process.stdout.write(`${formatResults(results)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
