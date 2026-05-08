import { callOpenBrainTool, resolveOpenBrainGroomingConfig } from './services/open-brain-runtime.js';

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const config = resolveOpenBrainGroomingConfig();
  if (!config) {
    throw new Error('Missing Open Brain grooming-bot config. Set OPEN_BRAIN_GROOMING_AGENT_MEMORY_KEY.');
  }

  const dryRun = hasFlag('--dry-run') || !hasFlag('--apply');
  const maxDeletes = Number(readArg('--max-deletes') ?? '10000');
  const result = await callOpenBrainTool(config, 'evict_agent_raw_captures', {
    agent_id: config.agentId,
    dry_run: dryRun,
    max_deletes: maxDeletes,
    force: hasFlag('--force'),
  });
  process.stdout.write(`${result.text}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
