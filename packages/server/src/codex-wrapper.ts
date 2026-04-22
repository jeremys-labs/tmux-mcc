import process from 'process';
import fs from 'fs';
import path from 'path';
import * as pty from 'node-pty';
import { resolveContentRoot } from './config.js';
import { ensureContentDirs } from './content.js';
import { ensureRuntimeStateDir, formatInboxEntryForCodex, readPendingInboxEntries } from './services/codex-inbox.js';

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

const poller = setInterval(() => {
  const pending = readPendingInboxEntries(contentRoot, agentKey);
  for (const entry of pending) {
    const prompt = formatInboxEntryForCodex(entry);
    injectChain = injectChain.then(async () => {
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
}, 2000);

function cleanup(): void {
  clearInterval(poller);
  process.stdout.off('resize', resize);
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
