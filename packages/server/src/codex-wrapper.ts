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
import { writePreSessionContextSidecar } from './services/runtime-pre-session.js';
import { createRuntimeEventEmitter } from './services/runtime-events.js';
import { startRuntimeInboxPollers } from './services/runtime-inbox-pollers.js';
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

const DEFAULT_AGENTS_ROOT = process.env.AGENTS_ROOT ?? '/Volumes/Repo-Drive/agents';
const hasSoul = fs.existsSync(path.join(DEFAULT_AGENTS_ROOT, agentKey, 'SOUL.md'));
writePreSessionContextSidecar({
  agentKey,
  contentRoot,
  hasSoul,
  hasMemory: openBrainConfig !== null,
  runtime: 'codex',
});

if (openBrainConfig) {
  fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} open-brain startup recall delegated to Codex SessionStart hook for ${agentKey} (soul=${hasSoul} memory=true)\n`);
} else {
  fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} open-brain runtime disabled or unconfigured for ${agentKey} (soul=${hasSoul} memory=false)\n`);
}

void runtimeEvents.emit('onRuntimeHealth', {
  source: 'runtime',
  metadata: { status: 'started' },
});

const pollers = startRuntimeInboxPollers({
  agentKey,
  contentRoot,
  events: runtimeEvents,
  openBrainConfig,
  runtimeLogPath,
  enqueue: taskQueue.enqueue,
  handoff: {
    workspace: cwd,
    // Route the handoff through the same readiness gate the inbox paths use. If the
    // window never opens the handoff is reported undelivered and left on disk for retry.
    submitHandoff: async (prompt) => {
      const readinessResult = await waitForCodexInjectionWindow();
      if (readinessResult === 'timeout') {
        fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} codex readiness wait timed out for handoff; leaving handoff pending for retry\n`);
        return false;
      }
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} injecting handoff: ${prompt}\n`);
      await submitRuntimePrompt(term, prompt, codexSubmitOptions);
      return true;
    },
  },
  blueBubbles: {
    submitPrompt: async (prompt, entry) => {
      const readinessResult = await waitForCodexInjectionWindow();
      if (readinessResult === 'timeout') {
        fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} codex readiness wait timed out for bluebubbles ${entry.id}; injecting anyway\n`);
      }
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} injecting bluebubbles ${entry.id}: ${prompt}\n`);
      await submitRuntimePrompt(term, prompt, codexSubmitOptions);
    },
  },
  discord: {
    submitPrompt: async (prompt, entry) => {
      const readinessResult = await waitForCodexInjectionWindow();
      if (readinessResult === 'timeout') {
        fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} codex readiness wait timed out for discord ${entry.id}; injecting anyway\n`);
      }
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} injecting ${entry.id}: ${prompt}\n`);
      await submitRuntimePrompt(term, prompt, codexSubmitOptions);
    },
  },
  agentMail: {
    mailStore,
    submitPrompt: async (prompt, message) => {
      const readinessResult = await waitForCodexInjectionWindow();
      if (readinessResult === 'timeout') {
        fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} codex readiness wait timed out for mail ${message.id}; injecting anyway\n`);
      }
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} injecting mail ${message.id}: ${prompt}\n`);
      await submitRuntimePrompt(term, prompt, codexSubmitOptions);
    },
  },
});

function cleanup(): void {
  pollers.stop();
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
