import process from 'process';
import fs from 'fs';
import path from 'path';
import * as pty from 'node-pty';
import { createAgentMailStore, formatAgentMailForRuntime } from '@agent-comms/mailbox';
import { resolveContentRoot } from './config.js';
import { ensureContentDirs } from './content.js';
import { buildAnswerContext } from './services/answer-context.js';
import {
  captureAgentMailMessage,
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
  const claudeArgs: string[] = [];

  while (args.length > 0) {
    const current = args.shift()!;
    if (current === '--agent') {
      agentKey = args.shift() ?? '';
      continue;
    }
    if (current === '--cd') {
      cwd = args.shift() ?? cwd;
      continue;
    }
    claudeArgs.push(current);
  }

  if (!agentKey) {
    throw new Error('Missing required --agent <agentKey>');
  }

  return { agentKey, cwd, claudeArgs };
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

const { agentKey, cwd, claudeArgs } = parseArgs(process.argv.slice(2));
const contentRoot = resolveContentRoot();
ensureContentDirs(contentRoot);
const runtimeLogPath = path.join(contentRoot, 'bridge', 'runtime-state', `${agentKey}.log`);
const store = createAgentMailStore();
let injectChain = Promise.resolve();
const deliveredIds = new Set<string>();
const openBrainConfig = resolveOpenBrainRuntimeConfig(agentKey);
const runtimeHandoff = loadPendingRuntimeHandoff(cwd);

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

injectRuntimeHandoff(term, cwd, runtimeHandoff?.injectableText ?? '');

const poller = setInterval(() => {
  const pending = store.listInbox({ agent: agentKey, status: 'new' });
  for (const message of pending) {
    if (deliveredIds.has(message.id)) continue;
    deliveredIds.add(message.id);
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
      term.write('\x15');
      await new Promise((resolve) => setTimeout(resolve, 40));
      term.write(prompt);
      await new Promise((resolve) => setTimeout(resolve, 80));
      term.write('\r');
      store.ackMessage(agentKey, message.id);
    }).catch(() => {
      deliveredIds.delete(message.id);
    });
  }
}, 15_000);

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
