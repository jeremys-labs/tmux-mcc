import {
  buildGroomingDigest,
  defaultSinceIso,
  fetchRawCapturesSince,
  readDigestState,
  resolveDigestChannelId,
  sendDiscordDigest,
  writeDigestState,
} from './services/open-brain-grooming-digest.js';

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
  const state = readDigestState();
  const sinceIso = readArg('--since') ?? defaultSinceIso(now, state);
  const limit = Number(readArg('--limit') ?? '80');
  const maxItems = Number(readArg('--max-items') ?? '12');
  const dryRun = hasFlag('--dry-run');

  const rows = await fetchRawCapturesSince(sinceIso, limit);
  const digest = buildGroomingDigest(rows, {
    sinceIso,
    generatedAtIso,
    channelId: resolveDigestChannelId(),
    maxItems,
  });

  if (dryRun) {
    process.stdout.write(`${digest}\n`);
    return;
  }

  await sendDiscordDigest(digest);
  writeDigestState({ ...state, lastRunIso: generatedAtIso });
  process.stdout.write(`Sent OB1 grooming digest for ${rows.length} raw captures since ${sinceIso}.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});

