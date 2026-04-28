import { resolveDigestChannelId, sendDiscordDigest, writeDigestState } from './services/open-brain-grooming-digest.js';
import { runScheduledGrooming } from './services/open-brain-grooming-schedule.js';

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const now = new Date();
  const generatedAtIso = now.toISOString();
  const sinceIso = readArg('--since');
  const limit = Number(readArg('--limit') ?? '80');
  const maxItems = Number(readArg('--max-items') ?? '12');
  const dryRun = hasFlag('--dry-run');
  const result = await runScheduledGrooming({
    actorAgent: 'eli',
    sinceIso,
    generatedAtIso,
    limit,
    maxItems,
    dryRun,
  });

  if (dryRun) {
    process.stdout.write(`${result.digest}\n`);
    return;
  }

  await sendDiscordDigest(result.digest, resolveDigestChannelId());
  writeDigestState({ lastRunIso: generatedAtIso });
  process.stdout.write(`Sent OB1 grooming digest for ${result.rawCaptureCount} raw captures since ${sinceIso ?? 'previous run'}.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
