import process from 'process';
import fs from 'fs';
import path from 'path';
import * as pty from 'node-pty';
import { createAgentMailStore, formatAgentMailForRuntime } from '@agent-comms/mailbox';
import { resolveContentRoot } from './config.js';
import { ensureContentDirs } from './content.js';
import {
  ensureRuntimeStateDir,
  formatInboxEntryForCodex,
  markInboxEntryDelivered,
  readPendingInboxEntries,
} from './services/codex-inbox.js';
import { buildAnswerContext } from './services/answer-context.js';
import {
  captureAgentMailMessage,
  captureDiscordInboxEntry,
  resolveOpenBrainRuntimeConfig,
} from './services/open-brain-runtime.js';
import {
  loadPendingRuntimeHandoff,
  markRuntimeHandoffConsumed,
} from './services/runtime-handoff.js';

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

function injectRuntimeHandoff(term: pty.IPty, cwd: string, handoff: string): void {
  const trimmed = handoff.trim();
  if (!trimmed) return;
  term.write('\x15');
  setTimeout(() => {
    term.write(`[Runtime Handoff]\n\n${trimmed}\n`);
    setTimeout(() => {
      term.write('\r');
      try {
        markRuntimeHandoffConsumed(cwd);
      } catch {
        // Leave the handoff file in place rather than crashing the wrapper.
      }
    }, 80);
  }, 40);
}

const { agentKey, cwd, codexArgs } = parseArgs(process.argv.slice(2));
const contentRoot = resolveContentRoot();
ensureContentDirs(contentRoot);
ensureRuntimeStateDir(contentRoot);
const runtimeLogPath = path.join(contentRoot, 'bridge', 'runtime-state', `${agentKey}.log`);
let injectChain = Promise.resolve();
const mailStore = createAgentMailStore();
const deliveredMailIds = new Set<string>();
const deliveredInboxIds = new Set<string>();
const openBrainConfig = resolveOpenBrainRuntimeConfig(agentKey);
const runtimeHandoff = loadPendingRuntimeHandoff(cwd);

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
  fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} open-brain startup recall delegated to Codex SessionStart hook for ${agentKey}\n`);
} else {
  fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} open-brain runtime disabled or unconfigured for ${agentKey}\n`);
}

injectRuntimeHandoff(term, cwd, runtimeHandoff?.injectableText ?? '');

const poller = setInterval(() => {
  const pending = readPendingInboxEntries(contentRoot, agentKey);
  for (const entry of pending) {
    if (deliveredInboxIds.has(entry.id)) continue;
    deliveredInboxIds.add(entry.id);
    injectChain = injectChain.then(async () => {
      if (openBrainConfig) {
        try {
          await captureDiscordInboxEntry(openBrainConfig, entry);
          fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} captured discord ${entry.id} to open-brain raw_capture\n`);
        } catch (error) {
          fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} open-brain discord capture error ${entry.id}: ${String(error)}\n`);
        }
      }
      const answerContext = await buildAnswerContext({
        agentKey,
        source: 'discord',
        text: entry.content,
        openBrainConfig,
      }).catch((error) => {
        fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} answer-context discord error ${entry.id}: ${String(error)}\n`);
        return '';
      });
      if (answerContext) {
        fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} built answer-context for discord ${entry.id}\n`);
      }
      const prompt = [answerContext, formatInboxEntryForCodex(entry)].filter(Boolean).join('\n\n');
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} injecting ${entry.id}: ${prompt}\n`);
      term.write('\x15'); // Ctrl+U clears the current input line in common TUI shells
      await new Promise((resolve) => setTimeout(resolve, 40));
      term.write(prompt);
      await new Promise((resolve) => setTimeout(resolve, 80));
      term.write('\r');
      markInboxEntryDelivered(contentRoot, agentKey, entry);
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} submitted ${entry.id}\n`);
    }).catch((error) => {
      deliveredInboxIds.delete(entry.id);
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} inject error ${entry.id}: ${String(error)}\n`);
    });
  }

  const pendingMail = mailStore.listInbox({ agent: agentKey, status: 'new' });
  for (const message of pendingMail) {
    if (deliveredMailIds.has(message.id)) continue;
    deliveredMailIds.add(message.id);
    injectChain = injectChain.then(async () => {
      if (openBrainConfig) {
        try {
          await captureAgentMailMessage(openBrainConfig, message);
          fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} captured mail ${message.id} to open-brain raw_capture\n`);
        } catch (error) {
          fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} open-brain mail capture error ${message.id}: ${String(error)}\n`);
        }
      }
      const answerContext = await buildAnswerContext({
        agentKey,
        source: 'agent_mail',
        subject: message.subject,
        text: message.bodyMd,
        project: message.relatedProject,
        openBrainConfig,
      }).catch((error) => {
        fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} answer-context mail error ${message.id}: ${String(error)}\n`);
        return '';
      });
      if (answerContext) {
        fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} built answer-context for mail ${message.id}\n`);
      }
      const prompt = [answerContext, formatAgentMailForRuntime(message)].filter(Boolean).join('\n\n');
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
