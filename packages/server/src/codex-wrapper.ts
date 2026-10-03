import { execFileSync } from 'node:child_process';
import process from 'process';
import fs from 'fs';
import path from 'path';
import * as pty from 'node-pty';
import { createAgentMailStore } from '@agent-comms/mailbox';
import { createEventInboxStore } from '@agent-comms/event-inbox';
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
import { createCodexInjectionGate } from './services/runtime-codex-injection.js';
import { createStdinGate } from './services/runtime-stdin-gate.js';
import { submitRuntimePrompt, type SubmitOutcome } from './services/runtime-pty.js';
import { codexPromptLeftComposer } from './services/codex-composer.js';
import { createRuntimeTaskQueue } from './services/runtime-task-queue.js';
import { parseRuntimeWrapperArgs } from './services/runtime-wrapper-args.js';
import { appendInjectionJournalEntry, type InjectionSource } from './services/runtime-injection-journal.js';
import { ensureCodexUpdateGuard } from './services/codex-update-guard.js';

process.env.AGENT_MAIL_DIR ??= '/Volumes/Repo-Drive/agents/SHARED/agent-mail';

const { agentKey, cwd, runtimeArgs: codexArgs } = parseRuntimeWrapperArgs(process.argv.slice(2), {
  forwardAfterDoubleDash: true,
});
const contentRoot = resolveContentRoot();
ensureContentDirs(contentRoot);
ensureRuntimeStateDir(contentRoot);
const runtimeLogPath = path.join(contentRoot, 'bridge', 'runtime-state', `${agentKey}.log`);
const taskQueue = createRuntimeTaskQueue({
  defaultTimeoutMs: Number(process.env.RUNTIME_INJECTION_TASK_TIMEOUT_MS ?? '120000'),
});
const mailStore = createAgentMailStore();
const eventInbox = createEventInboxStore(path.join(contentRoot, 'databases', 'event-inbox.db'));
const openBrainConfig = resolveOpenBrainRuntimeConfig(agentKey);
const runtimeEvents = createRuntimeEventEmitter({
  agent: agentKey,
  runtime: 'codex',
  logPath: runtimeLogPath,
});
const operatorAgent = process.env.RUNTIME_OPERATOR_AGENT ?? 'isla';

/**
 * tmux has already parsed codex's cursor positioning into a screen. Reading that is strictly
 * better than re-deriving it from the byte stream, and it needs no new dependency —
 * `runtime-terminal-screen.ts` would, and `@xterm/headless` is not installed.
 *
 * Absent TMUX_PANE this is undefined and the gate keeps its stream-only behaviour.
 */
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

const readiness = createCodexReadinessGate({
  onTransition: (state, marker) => appendRuntimeLog(`codex readiness gate -> ${state} (${marker})`),
  // Previously unwired, so `oversized-fragment-dropped` had no consumer either.
  onNotice: (message) => appendRuntimeLog(`codex readiness notice: ${message}`),
  readScreen: readRenderedScreen,
});
if (!tmuxPane) {
  appendRuntimeLog('codex readiness WARNING: TMUX_PANE unset — screen fallback unavailable, stream-only readiness');
}
const codexSubmitOptions = {
  chunkSize: Number(process.env.CODEX_WRAPPER_PROMPT_CHUNK_SIZE ?? '160'),
  chunkDelayMs: Number(process.env.CODEX_WRAPPER_PROMPT_CHUNK_DELAY_MS ?? '8'),
  // No hardcoded value here: an explicit 120 overrode runtime-pty's length-scaled delay
  // (the 2026-09-13 truncation fix), so codex was the one runtime that never got it.
  submitDelayMs: process.env.CODEX_WRAPPER_PROMPT_SUBMIT_DELAY_MS
    ? Number(process.env.CODEX_WRAPPER_PROMPT_SUBMIT_DELAY_MS)
    : undefined,
  confirmSubmitted: readRenderedScreen
    ? () => codexPromptLeftComposer(readRenderedScreen())
    : undefined,
  submitConfirmAttempts: Number(process.env.CODEX_WRAPPER_SUBMIT_CONFIRM_ATTEMPTS ?? '3'),
  submitConfirmDelayMs: Number(process.env.CODEX_WRAPPER_SUBMIT_CONFIRM_DELAY_MS ?? '1500'),
  onSubmitRetry: (attempt: number) => appendRuntimeLog(`codex submit not confirmed; re-sending Enter (retry ${attempt})`),
};

function logSubmitOutcome(outcome: SubmitOutcome, label: string): void {
  appendRuntimeLog(`codex submit outcome for ${label}: ${outcome}`);
  if (outcome !== 'unconfirmed' || operatorAgent === agentKey) return;
  try {
    const sent = mailStore.send({
      fromAgent: agentKey,
      toAgent: operatorAgent,
      type: 'alert',
      priority: 'high',
      subject: `Codex prompt stuck unsubmitted: ${agentKey}`,
      bodyMd: [
        `A ${label} prompt was written to ${agentKey}'s composer and Enter did not submit it,`,
        'even after retries. It is still sitting in the composer: press Enter in the pane.',
        'Do NOT replay-inbound; that would paste it a second time.',
        '',
        `Runtime log: ${runtimeLogPath}`,
      ].join('\n'),
      requiresResponse: true,
    });
    appendRuntimeLog(`codex submit UNCONFIRMED routed to ${operatorAgent} as ${sent.id}`);
  } catch (error) {
    appendRuntimeLog(`codex submit UNCONFIRMED route FAILED to ${operatorAgent}: ${String(error)}`);
  }
}
const readinessWaitTimeoutMs = Number(process.env.CODEX_WRAPPER_READINESS_WAIT_TIMEOUT_MS ?? '5000');
const unackedRetryBudget = Number(process.env.CODEX_WRAPPER_UNACKED_RETRY_BUDGET ?? '3');

function appendRuntimeLog(line: string): void {
  fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} ${line}\n`);
}

function createCodexEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (key.startsWith('npm_')) continue;
    env[key] = value;
  }
  return env;
}

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

// Boot hardening: a headless codex boot wedges on the interactive update
// dialog unless check_for_update_on_startup=false is set at config root.
const codexHome = process.env.CODEX_HOME ?? path.join(process.env.HOME ?? '', '.codex');
const updateGuard = ensureCodexUpdateGuard(codexHome);
appendRuntimeLog(`codex update guard: ${updateGuard.status}${updateGuard.patched ? ' -> injected check_for_update_on_startup=false' : ''} (${codexHome})`);
if (updateGuard.status === 'explicitly-enabled' || updateGuard.status === 'no-config') {
  appendRuntimeLog('codex update guard WARNING: startup update check not disabled — headless boot may wedge on the update dialog');
}

const term = pty.spawn('codex', codexArgs, {
  name: process.env.TERM || 'xterm-256color',
  cols: process.stdout.columns || 120,
  rows: process.stdout.rows || 40,
  cwd,
  env: createCodexEnv(process.env),
});

const stdinGate = createStdinGate((data) => term.write(data));
const injectionGate = createCodexInjectionGate({
  waitForWindow: waitForCodexInjectionWindow,
  submit: async (prompt) => {
    const outcome = await stdinGate.run(() => submitRuntimePrompt(term, prompt, codexSubmitOptions));
    logSubmitOutcome(outcome, 'inbound');
  },
  retryBudget: unackedRetryBudget,
  canInjectWithoutConfirmation: () => readiness.hasReachedPrompt(),
  log: appendRuntimeLog,
  onFault: (message) => {
    // Mail SENDING is unaffected by this fault; only injection INTO this runtime is broken.
    if (operatorAgent === agentKey) return;
    try {
      const sent = mailStore.send({
        fromAgent: agentKey,
        toAgent: operatorAgent,
        type: 'alert',
        priority: 'high',
        subject: `Codex runtime undeliverable: ${agentKey}`,
        bodyMd: [
          message,
          '',
          `Agent: ${agentKey}`,
          'Runtime: codex',
          `Runtime log: ${runtimeLogPath}`,
          '',
          'Inbound mail is queued and unacked, so nothing is lost; it delivers once this',
          'runtime reaches a prompt again. This alert is sent once per stuck episode.',
        ].join('\n'),
        requiresResponse: true,
      });
      appendRuntimeLog(`codex FAULT routed to ${operatorAgent} as ${sent.id}`);
    } catch (error) {
      appendRuntimeLog(`codex FAULT route FAILED to ${operatorAgent}: ${String(error)}`);
    }
  },
});

const deliverJournaled = async (prompt: string, id: string, label: string, source: InjectionSource): Promise<void> => {
  await injectionGate.deliver(prompt, id, label);
  appendInjectionJournalEntry(contentRoot, agentKey, {
    ts: new Date().toISOString(),
    source,
    promptLength: prompt.length,
  });
};

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
  stdinGate.passthrough(data.toString());
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
      logSubmitOutcome(await stdinGate.run(() => submitRuntimePrompt(term, prompt, codexSubmitOptions)), 'handoff');
      appendInjectionJournalEntry(contentRoot, agentKey, {
        ts: new Date().toISOString(),
        source: 'handoff',
        promptLength: prompt.length,
      });
      return true;
    },
  },
  blueBubbles: {
    submitPrompt: (prompt, entry) => deliverJournaled(prompt, entry.id, 'bluebubbles', 'bluebubbles'),
  },
  discord: {
    submitPrompt: (prompt, entry) => deliverJournaled(prompt, entry.id, 'discord', 'discord'),
  },
  agentMail: {
    mailStore,
    submitPrompt: (prompt, message) => deliverJournaled(prompt, message.id, 'mail', 'agent-mail'),
  },
  eventInbox: {
    eventInbox,
    submitPrompt: (prompt, event) => deliverJournaled(prompt, String(event.id), 'event-inbox', 'event-inbox'),
  },
});

function cleanup(): void {
  pollers.stop();
  process.stdout.off('resize', resize);
  mailStore.close();
  eventInbox.close();
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
