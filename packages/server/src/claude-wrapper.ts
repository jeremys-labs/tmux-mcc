import process from 'process';
import path from 'path';
import * as pty from 'node-pty';
import { createAgentMailStore } from '@agent-comms/mailbox';
import { resolveContentRoot } from './config.js';
import { ensureContentDirs } from './content.js';
import { ensureRuntimeStateDir } from './services/codex-inbox.js';
import { resolveOpenBrainRuntimeConfig } from './services/open-brain-runtime.js';
import { createRuntimeEventEmitter } from './services/runtime-events.js';
import { enqueuePendingRuntimeAgentMail } from './services/runtime-agent-mail.js';
import { enqueuePendingRuntimeDiscordInbox } from './services/runtime-discord-inbox.js';
import { injectPendingRuntimeHandoff } from './services/runtime-handoff-injection.js';
import { submitRuntimePrompt } from './services/runtime-pty.js';
import { createRuntimeTaskQueue } from './services/runtime-task-queue.js';
import { parseRuntimeWrapperArgs } from './services/runtime-wrapper-args.js';

process.env.AGENT_MAIL_DIR ??= '/Volumes/Repo-Drive/agents/SHARED/agent-mail';

const { agentKey, cwd, runtimeArgs: claudeArgs } = parseRuntimeWrapperArgs(process.argv.slice(2));
const contentRoot = resolveContentRoot();
ensureContentDirs(contentRoot);
ensureRuntimeStateDir(contentRoot);
const runtimeLogPath = path.join(contentRoot, 'bridge', 'runtime-state', `${agentKey}.log`);
const store = createAgentMailStore();
const taskQueue = createRuntimeTaskQueue();
const deliveredMailIds = new Set<string>();
const deliveredInboxIds = new Set<string>();
const openBrainConfig = resolveOpenBrainRuntimeConfig(agentKey);
const runtimeEvents = createRuntimeEventEmitter({
  agent: agentKey,
  runtime: 'claude',
  logPath: runtimeLogPath,
});

const term = pty.spawn('claude', claudeArgs, {
  name: process.env.TERM || 'xterm-256color',
  cols: process.stdout.columns || 120,
  rows: process.stdout.rows || 40,
  cwd,
  env: process.env as Record<string, string>,
});

term.onData((data) => {
  process.stdout.write(data);
});

term.onExit(({ exitCode }) => {
  cleanup();
  process.exit(exitCode);
});

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.on('data', (data) => {
  term.write(data.toString());
});

const resize = () => {
  term.resize(process.stdout.columns || 120, process.stdout.rows || 40);
};
process.stdout.on('resize', resize);

void runtimeEvents.emit('onRuntimeHealth', {
  source: 'runtime',
  metadata: { status: 'started' },
});

taskQueue.enqueue(async () => {
  await injectPendingRuntimeHandoff({
    workspace: cwd,
    events: runtimeEvents,
    submitHandoff: (prompt) => submitRuntimePrompt(term, prompt),
  });
});

const poller = setInterval(() => {
  enqueuePendingRuntimeDiscordInbox({
    agentKey,
    contentRoot,
    deliveredIds: deliveredInboxIds,
    events: runtimeEvents,
    openBrainConfig,
    runtimeLogPath,
    submitPrompt: async (prompt, entry) => {
      await submitRuntimePrompt(term, prompt);
    },
    enqueue: taskQueue.enqueue,
  });

  enqueuePendingRuntimeAgentMail({
    agentKey,
    mailStore: store,
    deliveredIds: deliveredMailIds,
    events: runtimeEvents,
    openBrainConfig,
    runtimeLogPath,
    submitPrompt: (prompt) => submitRuntimePrompt(term, prompt),
    enqueue: taskQueue.enqueue,
  });
}, 2_000);

function cleanup(): void {
  clearInterval(poller);
  process.stdout.off('resize', resize);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  store.close();
}

process.on('SIGINT', () => {
  cleanup();
  term.kill();
});

process.on('SIGTERM', () => {
  cleanup();
  term.kill();
});
