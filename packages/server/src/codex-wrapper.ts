import process from 'process';
import fs from 'fs';
import path from 'path';
import * as pty from 'node-pty';
import { createAgentMailStore, formatAgentMailForRuntime } from '@agent-comms/mailbox';
import { resolveContentRoot } from './config.js';
import { ensureContentDirs } from './content.js';
import { ensureRuntimeStateDir, formatInboxEntryForCodex, readPendingInboxEntries } from './services/codex-inbox.js';
import {
  captureAgentMailMessage,
  captureDiscordInboxEntry,
  formatStartupMemoryForCodex,
  resolveOpenBrainRuntimeConfig,
  searchStartupMemory,
} from './services/open-brain-runtime.js';

process.env.AGENT_MAIL_DIR ??= '/Volumes/Repo-Drive/agents/SHARED/agent-mail';

function parseArgs(argv: string[]) {
  const args = [...argv];
  let agentKey = '';
  let cwd = process.cwd();
  const codexArgs: string[] = [];
  let forwardToCodex = false;

  while (args.length > 0) {
    const current = args.shift()!;
    if (current === '--') {
      forwardToCodex = true;
      continue;
    }
    if (forwardToCodex) {
      codexArgs.push(current);
      continue;
    }
    if (current === '--agent') {
      agentKey = args.shift() ?? '';
      continue;
    }
    if (current === '--cd') {
      cwd = args.shift() ?? cwd;
      continue;
    }
    codexArgs.push(current);
  }

  if (!agentKey) {
    throw new Error('Missing required --agent <agentKey>');
  }

  return { agentKey, cwd, codexArgs };
}

const { agentKey, cwd, codexArgs } = parseArgs(process.argv.slice(2));
const contentRoot = resolveContentRoot();
ensureContentDirs(contentRoot);
ensureRuntimeStateDir(contentRoot);
const runtimeLogPath = path.join(contentRoot, 'bridge', 'runtime-state', `${agentKey}.log`);
let injectChain = Promise.resolve();
const mailStore = createAgentMailStore();
const deliveredMailIds = new Set<string>();
const openBrainConfig = resolveOpenBrainRuntimeConfig(agentKey);

const term = pty.spawn('codex', codexArgs, {
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

if (openBrainConfig) {
  injectChain = injectChain.then(async () => {
    try {
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} open-brain startup recall started\n`);
      const memoryText = await searchStartupMemory(openBrainConfig);
      const prompt = formatStartupMemoryForCodex(agentKey, memoryText);
      if (!prompt) return;
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} injecting open-brain startup recall\n`);
      term.write('\x15');
      await new Promise((resolve) => setTimeout(resolve, 40));
      term.write(prompt);
      await new Promise((resolve) => setTimeout(resolve, 80));
      term.write('\r');
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} submitted open-brain startup recall\n`);
    } catch (error) {
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} open-brain startup recall error: ${String(error)}\n`);
    }
  });
} else {
  fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} open-brain runtime disabled or unconfigured for ${agentKey}\n`);
}

const poller = setInterval(() => {
  const pending = readPendingInboxEntries(contentRoot, agentKey);
  for (const entry of pending) {
    const prompt = formatInboxEntryForCodex(entry);
    injectChain = injectChain.then(async () => {
      if (openBrainConfig) {
        try {
          await captureDiscordInboxEntry(openBrainConfig, entry);
          fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} captured discord ${entry.id} to open-brain raw_capture\n`);
        } catch (error) {
          fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} open-brain discord capture error ${entry.id}: ${String(error)}\n`);
        }
      }
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} injecting ${entry.id}: ${prompt}\n`);
      term.write('\x15'); // Ctrl+U clears the current input line in common TUI shells
      await new Promise((resolve) => setTimeout(resolve, 40));
      term.write(prompt);
      await new Promise((resolve) => setTimeout(resolve, 80));
      term.write('\r');
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} submitted ${entry.id}\n`);
    }).catch((error) => {
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} inject error ${entry.id}: ${String(error)}\n`);
    });
  }

  const pendingMail = mailStore.listInbox({ agent: agentKey, status: 'new' });
  for (const message of pendingMail) {
    if (deliveredMailIds.has(message.id)) continue;
    deliveredMailIds.add(message.id);
    const prompt = formatAgentMailForRuntime(message);
    injectChain = injectChain.then(async () => {
      if (openBrainConfig) {
        try {
          await captureAgentMailMessage(openBrainConfig, message);
          fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} captured mail ${message.id} to open-brain raw_capture\n`);
        } catch (error) {
          fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} open-brain mail capture error ${message.id}: ${String(error)}\n`);
        }
      }
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} injecting mail ${message.id}: ${prompt}\n`);
      term.write('\x15');
      await new Promise((resolve) => setTimeout(resolve, 40));
      term.write(prompt);
      await new Promise((resolve) => setTimeout(resolve, 80));
      term.write('\r');
      mailStore.ackMessage(agentKey, message.id);
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} acknowledged mail ${message.id}\n`);
    }).catch((error) => {
      deliveredMailIds.delete(message.id);
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} mail inject error ${message.id}: ${String(error)}\n`);
    });
  }
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
