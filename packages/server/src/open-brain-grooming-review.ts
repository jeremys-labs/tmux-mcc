import { reviewRawCapture, type GroomingReviewAction, type PromotionScope } from './services/open-brain-grooming-review.js';

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
  throw new Error('Usage: open-brain:grooming-review --action promote|deprecate|ignore --source-ref <source_ref> [--scope private_agent|project|shared_team]');
}

function parseScope(raw?: string): PromotionScope | undefined {
  if (!raw) return undefined;
  if (raw === 'private_agent' || raw === 'project' || raw === 'shared_team') return raw;
  throw new Error(`Invalid scope: ${raw}`);
}

async function main(): Promise<void> {
  const action = parseAction(readArg('--action'));
  const sourceRef = readArg('--source-ref');
  if (!sourceRef) throw new Error('Missing --source-ref');

  const message = await reviewRawCapture({
    action,
    sourceRef,
    scope: parseScope(readArg('--scope')),
    actorAgent: readArg('--actor') ?? 'eli',
    authority: readArg('--authority') as 'source_of_truth' | 'context' | undefined,
    approvedShared: hasFlag('--approved-shared'),
    content: readArg('--content'),
  });
  process.stdout.write(`${message}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
