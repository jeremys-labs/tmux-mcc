import {
  buildOperatorDashboard,
  formatOperatorDashboard,
} from './services/open-brain-operator-dashboard.js';

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function sinceIso(now: Date): string {
  const explicit = readArg('--since');
  if (explicit) return new Date(explicit).toISOString();
  const hours = Number(readArg('--since-hours') ?? '24');
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('--since-hours must be a positive number');
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

async function main(): Promise<void> {
  const now = new Date();
  const model = await buildOperatorDashboard({
    sinceIso: sinceIso(now),
    nowIso: now.toISOString(),
    includeLiveRawCaptures: !hasFlag('--no-live'),
    liveRawCaptureLimit: Number(readArg('--live-limit') ?? '200'),
  });

  if (hasFlag('--json')) {
    process.stdout.write(`${JSON.stringify(model, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${formatOperatorDashboard(model)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
