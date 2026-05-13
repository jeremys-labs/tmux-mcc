import { buildRuntimeHealthReport, formatRuntimeHealthSummary } from './services/runtime-health.js';

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const agentsArg = readArg('--agents');
  const requireMigrationReady = hasFlag('--require-migration-ready');
  const report = await buildRuntimeHealthReport({
    agents: agentsArg ? agentsArg.split(',').map((item) => item.trim()).filter(Boolean) : undefined,
    openBrainSearchTimeoutMs: Number(readArg('--ob1-search-timeout-ms') ?? '1000'),
    includeOpenBrainSearch: !hasFlag('--skip-ob1-search'),
  });

  if (hasFlag('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${formatRuntimeHealthSummary(report)}\n`);
  if (requireMigrationReady) {
    const failingAgents = report.agents.filter((agent) => agent.migrationReadiness.status !== 'ok');
    if (failingAgents.length > 0) {
      process.stderr.write(`Migration readiness failed for: ${failingAgents.map((agent) => agent.agent).join(', ')}\n`);
      process.exit(1);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
