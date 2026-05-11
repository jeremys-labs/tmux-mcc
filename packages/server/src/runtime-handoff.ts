import {
  buildRuntimeHandoff,
  writeRuntimeHandoff,
} from './services/runtime-handoff.js';

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'create') {
    throw new Error('Usage: runtime-handoff create --agent <agent> --from-runtime <runtime> --to-runtime <runtime> --workspace <path> [--reason <text>] [--notes <text>]');
  }

  const agent = readArg('--agent');
  const fromRuntime = readArg('--from-runtime');
  const toRuntime = readArg('--to-runtime');
  const workspace = readArg('--workspace');
  if (!agent || !fromRuntime || !toRuntime || !workspace) {
    throw new Error('Missing required handoff arguments');
  }

  const handoff = buildRuntimeHandoff({
    agent,
    fromRuntime,
    toRuntime,
    workspace,
    reason: readArg('--reason') ?? 'runtime switch requested',
    nextStepNotes: readArg('--notes') ?? '',
  });
  const filePath = writeRuntimeHandoff(workspace, handoff);
  process.stdout.write(`${filePath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
