import process from 'process';
import * as pty from 'node-pty';
import { createAgentMailStore, formatAgentMailForRuntime } from '@agent-comms/mailbox';

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

const { agentKey, cwd, claudeArgs } = parseArgs(process.argv.slice(2));
const store = createAgentMailStore();
let injectChain = Promise.resolve();
const deliveredIds = new Set<string>();

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

const poller = setInterval(() => {
  const pending = store.listInbox({ agent: agentKey, status: 'new' });
  for (const message of pending) {
    if (deliveredIds.has(message.id)) continue;
    deliveredIds.add(message.id);
    const prompt = formatAgentMailForRuntime(message);
    injectChain = injectChain.then(async () => {
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
