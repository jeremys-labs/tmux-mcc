import { spawn } from 'child_process';
import { buildRuntimeLaunchPlan, parseSupportedRuntime } from './services/runtime-launch-plan.js';

type ParsedArgs = {
  agent: string;
  runtime: string;
  agentDir: string;
  dryRun: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    agent: '',
    runtime: process.env.LAUNCH_RUNTIME ?? 'claude',
    agentDir: process.cwd(),
    dryRun: false,
  };
  const args = [...argv];
  while (args.length > 0) {
    const current = args.shift()!;
    if (current === '--agent') {
      parsed.agent = args.shift() ?? '';
      continue;
    }
    if (current === '--runtime') {
      parsed.runtime = args.shift() ?? '';
      continue;
    }
    if (current.startsWith('--runtime=')) {
      parsed.runtime = current.slice('--runtime='.length);
      continue;
    }
    if (current === '--cd') {
      parsed.agentDir = args.shift() ?? parsed.agentDir;
      continue;
    }
    if (current === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    throw new Error(`Unknown argument: ${current}`);
  }
  if (!parsed.agent) {
    throw new Error('Missing required --agent <agent>');
  }
  return parsed;
}

const parsed = parseArgs(process.argv.slice(2));
const plan = buildRuntimeLaunchPlan({
  agent: parsed.agent,
  agentDir: parsed.agentDir,
  runtime: parseSupportedRuntime(parsed.runtime),
});

if (parsed.dryRun) {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.exit(0);
}

const child = spawn(plan.command, plan.args, {
  cwd: plan.cwd,
  env: {
    ...process.env,
    ...plan.env,
  },
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
