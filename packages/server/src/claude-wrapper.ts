import process from 'process';
import fs from 'fs';
import path from 'path';
import * as pty from 'node-pty';
import { createAgentMailStore } from '@agent-comms/mailbox';
import { resolveContentRoot } from './config.js';
import { ensureContentDirs } from './content.js';
import { ensureRuntimeStateDir } from './services/codex-inbox.js';
import { resolveOpenBrainRuntimeConfig } from './services/open-brain-runtime.js';
import { appendRuntimeEventToLog, createRuntimeEventEmitter } from './services/runtime-events.js';
import { createSharedActivitySink } from './services/runtime-shared-activity.js';
import { startRuntimeInboxPollers } from './services/runtime-inbox-pollers.js';
import { detectModelSwitch, injectModelSwitch } from './services/runtime-model-switch.js';
import {
  buildPreSessionPrompt,
  writePreSessionPromptFile,
} from './services/runtime-pre-session.js';
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
const openBrainConfig = resolveOpenBrainRuntimeConfig(agentKey);
const runtimeEvents = createRuntimeEventEmitter({
  agent: agentKey,
  runtime: 'claude',
  sinks: [appendRuntimeEventToLog(runtimeLogPath), createSharedActivitySink()],
});

const preSession = await buildPreSessionPrompt({
  agentKey,
  runtime: 'claude',
  openBrainConfig,
});
if (preSession.text) {
  const file = writePreSessionPromptFile({
    agentKey,
    contentRoot,
    text: preSession.text,
    hasSoul: preSession.hasSoul,
    hasMemory: preSession.hasMemory,
    runtime: 'claude',
  });
  claudeArgs.push('--append-system-prompt-file', file);
  fs.appendFileSync(
    runtimeLogPath,
    `${new Date().toISOString()} pre-session prompt assembled (soul=${preSession.hasSoul} memory=${preSession.hasMemory}) -> ${file}\n`,
  );
} else {
  fs.appendFileSync(
    runtimeLogPath,
    `${new Date().toISOString()} pre-session prompt skipped (no SOUL.md, no OB1 config)\n`,
  );
}

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

term.onExit(async ({ exitCode, signal }) => {
  await runtimeEvents.emit('onRuntimeHealth', {
    source: 'runtime',
    metadata: {
      status: 'stopped',
      reason: signal ? `signal:${signal}` : `exit:${exitCode}`,
    },
  });
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

const pollers = startRuntimeInboxPollers({
  agentKey,
  contentRoot,
  events: runtimeEvents,
  openBrainConfig,
  runtimeLogPath,
  enqueue: taskQueue.enqueue,
  handoff: {
    workspace: cwd,
    submitHandoff: async (prompt) => {
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} injecting handoff: ${prompt}\n`);
      await submitRuntimePrompt(term, prompt);
    },
  },
  blueBubbles: {
    submitPrompt: (prompt) => submitRuntimePrompt(term, prompt),
  },
  discord: {
    submitPrompt: async (prompt, entry) => {
      const switchResult = detectModelSwitch(entry.content);
      if (switchResult.matched && switchResult.model) {
        await injectModelSwitch(term, switchResult.model);
      }
      await submitRuntimePrompt(term, prompt);
    },
  },
  agentMail: {
    mailStore: store,
    submitPrompt: (prompt) => submitRuntimePrompt(term, prompt),
  },
});

function cleanup(): void {
  pollers.stop();
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
