import process from 'process';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import * as pty from 'node-pty';
import { createAgentMailStore } from '@agent-comms/mailbox';
import { createEventInboxStore } from '@agent-comms/event-inbox';
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
import { appendInjectionJournalEntry } from './services/runtime-injection-journal.js';
import { createStdinGate } from './services/runtime-stdin-gate.js';
import { createRuntimeTaskQueue } from './services/runtime-task-queue.js';
import { parseRuntimeWrapperArgs } from './services/runtime-wrapper-args.js';

process.env.AGENT_MAIL_DIR ??= '/Volumes/Repo-Drive/agents/SHARED/agent-mail';

const { agentKey, cwd, runtimeArgs: claudeArgs } = parseRuntimeWrapperArgs(process.argv.slice(2));
const contentRoot = resolveContentRoot();
ensureContentDirs(contentRoot);
ensureRuntimeStateDir(contentRoot);
const runtimeLogPath = path.join(contentRoot, 'bridge', 'runtime-state', `${agentKey}.log`);
const store = createAgentMailStore();
const eventInbox = createEventInboxStore(path.join(contentRoot, 'databases', 'event-inbox.db'));
const taskQueue = createRuntimeTaskQueue({
  defaultTimeoutMs: Number(process.env.RUNTIME_INJECTION_TASK_TIMEOUT_MS ?? '120000'),
});
const openBrainConfig = resolveOpenBrainRuntimeConfig(agentKey);
const handoffSubmitDelayMs = Number(process.env.CLAUDE_WRAPPER_HANDOFF_SUBMIT_DELAY_MS ?? '1500');
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

const stdinGate = createStdinGate((data) => term.write(data));

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
  stdinGate.passthrough(data.toString());
});

const resize = () => {
  term.resize(process.stdout.columns || 120, process.stdout.rows || 40);
};
process.stdout.on('resize', resize);

void runtimeEvents.emit('onRuntimeHealth', {
  source: 'runtime',
  metadata: { status: 'started' },
});

const tmuxPane = process.env.TMUX_PANE;
const readRenderedScreen = tmuxPane
  ? (): string | null => {
      try {
        return execFileSync('tmux', ['capture-pane', '-p', '-t', tmuxPane], {
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        return null;
      }
    }
  : undefined;

function logRuntime(message: string): void {
  fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} ${message}\n`);
}

// 2026-10-04: the injector's default 512-char chunks at 10ms arrive as a paste burst, and
// Claude Code damages everything after the first chunk. Measured across nine claude agents'
// transcripts: the first tag lands at offset 514 (the 512 boundary) with ~1050-char seams
// (1024 chars of content plus the length of the inserted tag itself). Two shapes, one
// boundary -- the middle is sometimes wrapped as a paste and sometimes dropped outright.
// Codex is unaffected because it passes chunkSize 160 explicitly.
//
// Only the chunk DELAY moves here. chunkSize stays at the default so the result is
// attributable to one variable, and chunkSize 0 is deliberately not an option: a single
// large write is the maximum-overflow case on a PTY whose write() has no backpressure
// signal at all.
// Claude Code's placeholder for a collapsed paste. The same pattern exists in the pending
// claude-composer module on marcus/claude-composer-closed-loop; unify on one definition when
// that lands rather than leaving two copies to drift.
const PASTE_PLACEHOLDER = /\[Pasted (Content|text)/i;

const claudeSubmitOptions = {
  chunkDelayMs: Number(process.env.CLAUDE_WRAPPER_PROMPT_CHUNK_DELAY_MS ?? '60'),
};

function submitClaudePrompt(prompt: string): Promise<unknown> {
  return submitRuntimePrompt(term, prompt, {
    ...claudeSubmitOptions,
    // The discriminator. Both candidate mechanisms predict that slowing the chunks helps,
    // so a clean run alone cannot say which was at fault. A paste placeholder is visible
    // here and nowhere later, because after the Enter the composer is empty either way.
    onBeforeSubmit: readRenderedScreen
      ? () => {
          // Time the capture. This probe runs AFTER submitDelayMs and immediately BEFORE the
          // Enter, so a slow synchronous capture silently widens the gap between the last
          // chunk and `\r` -- the same lever the 2026-09-13 truncation fix moved. Left
          // unmeasured, a clean run could be the chunk delay or could be this probe, and we
          // would credit the chunk delay. Logging the cost is what keeps the result readable.
          const started = Date.now();
          const screen = readRenderedScreen();
          const probeMs = Date.now() - started;
          const placeholder = screen === null ? 'unknown' : String(PASTE_PLACEHOLDER.test(screen));
          logRuntime(
            `claude pre-submit probe: promptChars=${prompt.length} pastePlaceholder=${placeholder} probeMs=${probeMs}`,
          );
        }
      : undefined,
  });
}

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
      await new Promise((resolve) => setTimeout(resolve, handoffSubmitDelayMs));
      await stdinGate.run(() => submitClaudePrompt(prompt));
      appendInjectionJournalEntry(contentRoot, agentKey, {
        ts: new Date().toISOString(),
        source: 'handoff',
        promptLength: prompt.length,
      });
    },
  },
  blueBubbles: {
    submitPrompt: async (prompt, entry) => {
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} injecting bluebubbles ${entry.id}: ${prompt}\n`);
      await stdinGate.run(() => submitClaudePrompt(prompt));
      appendInjectionJournalEntry(contentRoot, agentKey, {
        ts: new Date().toISOString(),
        source: 'bluebubbles',
        promptLength: prompt.length,
      });
    },
  },
  discord: {
    submitPrompt: async (prompt, entry) => stdinGate.run(async () => {
      const switchResult = detectModelSwitch(entry.content);
      if (switchResult.matched && switchResult.model) {
        fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} model switch requested via discord ${entry.id}: /model ${switchResult.model}\n`);
        await runtimeEvents.emit('onModelSwitch', {
          source: 'discord',
          messageId: entry.id,
          metadata: { model: switchResult.model },
        });
        await injectModelSwitch(term, switchResult.model);
      }
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} injecting discord ${entry.id}: ${prompt}\n`);
      await submitClaudePrompt(prompt);
      appendInjectionJournalEntry(contentRoot, agentKey, {
        ts: new Date().toISOString(),
        source: 'discord',
        promptLength: prompt.length,
      });
    }),
  },
  agentMail: {
    mailStore: store,
    submitPrompt: async (prompt, message) => {
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} injecting mail ${message.id}: ${prompt}\n`);
      await stdinGate.run(() => submitClaudePrompt(prompt));
      appendInjectionJournalEntry(contentRoot, agentKey, {
        ts: new Date().toISOString(),
        source: 'agent-mail',
        promptLength: prompt.length,
      });
    },
  },
  eventInbox: {
    eventInbox,
    submitPrompt: async (prompt, event) => {
      fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} injecting event-inbox ${event.id}: ${prompt}\n`);
      await stdinGate.run(() => submitClaudePrompt(prompt));
      appendInjectionJournalEntry(contentRoot, agentKey, {
        ts: new Date().toISOString(),
        source: 'event-inbox',
        promptLength: prompt.length,
      });
    },
  },
});

function cleanup(): void {
  pollers.stop();
  process.stdout.off('resize', resize);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  store.close();
  eventInbox.close();
}

process.on('SIGINT', () => {
  cleanup();
  term.kill();
});

process.on('SIGTERM', () => {
  cleanup();
  term.kill();
});
