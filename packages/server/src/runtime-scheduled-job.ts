import fs from 'fs';
import { spawn } from 'child_process';
import {
  buildScheduledRuntimeJobPlan,
  runtimeFromExecutor,
} from './services/scheduled-runtime-job.js';
import { parseSupportedRuntime } from './services/runtime-launch-plan.js';

type ParsedArgs = {
  agent: string;
  agentDir: string;
  executor?: string;
  runtime?: string;
  model?: string;
  effort?: string;
  promptFile: string;
  appendSystemPromptFile?: string;
  discordStateDir?: string;
  scheduledJobId?: string;
  scheduledJobLabel?: string;
  awaitingReply: boolean;
  dryRun: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    agent: '',
    agentDir: process.cwd(),
    promptFile: '',
    awaitingReply: process.env.SCHEDULED_AWAITING_REPLY === '1',
    dryRun: false,
  };
  const args = [...argv];
  while (args.length > 0) {
    const current = args.shift()!;
    if (current === '--agent') parsed.agent = args.shift() ?? '';
    else if (current === '--cd') parsed.agentDir = args.shift() ?? parsed.agentDir;
    else if (current === '--executor') parsed.executor = args.shift() ?? '';
    else if (current === '--runtime') parsed.runtime = args.shift() ?? '';
    else if (current === '--model') parsed.model = args.shift() ?? '';
    else if (current === '--effort') parsed.effort = args.shift() ?? '';
    else if (current === '--prompt-file') parsed.promptFile = args.shift() ?? '';
    else if (current === '--append-system-prompt-file') parsed.appendSystemPromptFile = args.shift() ?? '';
    else if (current === '--discord-state-dir') parsed.discordStateDir = args.shift() ?? '';
    else if (current === '--scheduled-job-id') parsed.scheduledJobId = args.shift() ?? '';
    else if (current === '--scheduled-job-label') parsed.scheduledJobLabel = args.shift() ?? '';
    else if (current === '--awaiting-reply') parsed.awaitingReply = true;
    else if (current === '--dry-run') parsed.dryRun = true;
    else throw new Error(`Unknown argument: ${current}`);
  }
  if (!parsed.agent) throw new Error('Missing required --agent <agent>');
  if (!parsed.promptFile) throw new Error('Missing required --prompt-file <path>');
  return parsed;
}

const parsed = parseArgs(process.argv.slice(2));
const runtime = parsed.runtime
  ? parseSupportedRuntime(parsed.runtime)
  : runtimeFromExecutor(parsed.executor, parsed.agentDir);
const prompt = fs.readFileSync(parsed.promptFile, 'utf8');
const appendSystemPrompt = parsed.appendSystemPromptFile
  ? fs.readFileSync(parsed.appendSystemPromptFile, 'utf8')
  : undefined;

const plan = buildScheduledRuntimeJobPlan({
  agent: parsed.agent,
  agentDir: parsed.agentDir,
  runtime,
  prompt,
  model: parsed.model,
  appendSystemPrompt,
  discordStateDir: parsed.discordStateDir,
  scheduledJobId: parsed.scheduledJobId ?? process.env.SCHEDULED_JOB_ID,
  scheduledJobLabel: parsed.scheduledJobLabel ?? process.env.SCHEDULED_JOB_LABEL,
  awaitingReply: parsed.awaitingReply,
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
