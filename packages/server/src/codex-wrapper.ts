import process from 'process';
import fs from 'fs';
import path from 'path';
import * as pty from 'node-pty';
import { createAgentMailStore } from '@agent-comms/mailbox';
import { resolveContentRoot } from './config.js';
import { ensureContentDirs } from './content.js';
import {
  ensureRuntimeStateDir,
} from './services/codex-inbox.js';
import { resolveOpenBrainRuntimeConfig } from './services/open-brain-runtime.js';
import { createRuntimeEventEmitter } from './services/runtime-events.js';
import { enqueuePendingRuntimeAgentMail } from './services/runtime-agent-mail.js';
import { enqueuePendingRuntimeBlueBubblesInbox } from './services/runtime-bluebubbles-inbox.js';
import { enqueuePendingRuntimeDiscordInbox } from './services/runtime-discord-inbox.js';
import { injectPendingRuntimeHandoff } from './services/runtime-handoff-injection.js';
import { createCodexReadinessGate } from './services/runtime-codex-readiness.js';
import { submitRuntimePrompt } from './services/runtime-pty.js';
import { createRuntimeTaskQueue } from './services/runtime-task-queue.js';
import { parseRuntimeWrapperArgs } from './services/runtime-wrapper-args.js';

process.env.AGENT_MAIL_DIR ??= '/Volumes/Repo-Drive/agents/SHARED/agent-mail';

const { agentKey, cwd, runtimeArgs: codexArgs } = parseRuntimeWrapperArgs(process.argv.slice(2), {
  forwardAfterDoubleDash: true,
});
const contentRoot = resolveContentRoot();
ensureContentDirs(contentRoot);
ensureRuntimeStateDir(contentRoot);
const runtimeLogPath = path.join(contentRoot, 'bridge', 'runtime-state', `${agentKey}.log`);
const taskQueue = createRuntimeTaskQueue();
const mailStore = createAgentMailStore();
const deliveredMailIds = new Set<string>();
const deliveredInboxIds = new Set<string>();
const deliveredBlueBubblesIds = new Set<string>();
const openBrainConfig = resolveOpenBrainRuntimeConfig(agentKey);
const runtimeEvents = createRuntimeEventEmitter({
  agent: agentKey,
  runtime: 'codex',
  logPath: runtimeLogPath,
});
const readiness = createCodexReadinessGate();
const codexSubmitOptions = {
  chunkSize: Number(process.env.CODEX_WRAPPER_PROMPT_CHUNK_SIZE ?? '160'),
  chunkDelayMs: Number(process.env.CODEX_WRAPPER_PROMPT_CHUNK_DELAY_MS ?? '8'),
  submitDelayMs: Number(process.env.CODEX_WRAPPER_PROMPT_SUBMIT_DELAY_MS ?? '120'),
};
const readinessWaitTimeoutMs = Number(process.env.CODEX_WRAPPER_READINESS_WAIT_TIMEOUT_MS ?? '5000');

async function waitForCodexInjectionWindow(): Promise<'idle' | 'timeout'> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      readiness.waitForIdle().then(() => 'idle' as const),
      new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), readinessWaitTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const term = pty.spawn('codex', codexArgs, {
  name: process.env.TERM || 'xterm-256color',
  cols: process.stdout.columns || 120,
  rows: process.stdout.rows || 40,
  cwd,
  env: process.env as Record<string, string>,
});

term.onData((data) => {
  readiness.onData(data);
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

if (openBrainConfig) {
  fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} open-brain startup recall delegated to Codex SessionStart hook for ${agentKey}\n`);
} else {
  fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} open-brain runtime disabled or unconfigured for ${agentKey}\n`);
}

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
  enqueuePendingRuntimeBlueBubblesInbox({
    agentKey,
    contentRoot,
    deliveredIds: deliveredBlueBubblesIds,
    events: runtimeEvents,
    openBrainConfig,
    runtimeLogPath,
    submitPrompt: async (prompt, entry) => {
      const readinessResult = await waitForCodexInjectionWindow();
      if (readinessResult === 'timeout') {
        fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} codex readiness wait timed out for bluebubbles ${entry.id}; injecting anyway\n`);
      }
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} injecting bluebubbles ${entry.id}: ${prompt}\n`);
      await submitRuntimePrompt(term, prompt, codexSubmitOptions);
    },
    enqueue: taskQueue.enqueue,
  });

  enqueuePendingRuntimeDiscordInbox({
    agentKey,
    contentRoot,
    deliveredIds: deliveredInboxIds,
    events: runtimeEvents,
    openBrainConfig,
    runtimeLogPath,
    submitPrompt: async (prompt, entry) => {
      const readinessResult = await waitForCodexInjectionWindow();
      if (readinessResult === 'timeout') {
        fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} codex readiness wait timed out for discord ${entry.id}; injecting anyway\n`);
      }
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} injecting ${entry.id}: ${prompt}\n`);
      await submitRuntimePrompt(term, prompt, codexSubmitOptions);
    },
    enqueue: taskQueue.enqueue,
  });

  enqueuePendingRuntimeAgentMail({
    agentKey,
    mailStore,
    deliveredIds: deliveredMailIds,
    events: runtimeEvents,
    openBrainConfig,
    runtimeLogPath,
    submitPrompt: async (prompt, message) => {
      const readinessResult = await waitForCodexInjectionWindow();
      if (readinessResult === 'timeout') {
        fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} codex readiness wait timed out for mail ${message.id}; injecting anyway\n`);
      }
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} injecting mail ${message.id}: ${prompt}\n`);
      await submitRuntimePrompt(term, prompt, codexSubmitOptions);
    },
    enqueue: taskQueue.enqueue,
  });
}, 2000);

function cleanup(): void {
  clearInterval(poller);
  process.stdout.off('resize', resize);
  mailStore.close();
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
}

process.on('SIGINT', () => {
  cleanup();
  term.kill();
});

process.on('SIGTERM', () => {
  cleanup();
  term.kill();
});
