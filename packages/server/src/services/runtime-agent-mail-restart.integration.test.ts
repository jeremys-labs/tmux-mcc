import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentMailStore, type AgentMailStore } from '@agent-comms/mailbox';
import { createRuntimeEventEmitter } from './runtime-events.js';

vi.mock('./runtime-discord-inbox.js', () => ({
  enqueuePendingRuntimeDiscordInbox: vi.fn(),
}));
vi.mock('./runtime-bluebubbles-inbox.js', () => ({
  enqueuePendingRuntimeBlueBubblesInbox: vi.fn(),
}));
vi.mock('./runtime-event-inbox.js', () => ({
  enqueuePendingRuntimeEventInbox: vi.fn(),
}));
vi.mock('./runtime-handoff-injection.js', () => ({
  injectPendingRuntimeHandoff: vi.fn(),
}));
vi.mock('./answer-context.js', () => ({
  buildAnswerContext: vi.fn(async () => ''),
}));
vi.mock('./open-brain-runtime.js', () => ({
  captureAgentMailMessage: vi.fn(),
}));

import { buildRuntimeHandoff } from './runtime-handoff.js';
import { startRuntimeInboxPollers } from './runtime-inbox-pollers.js';

describe('agent-mail restart recovery', () => {
  let tmpDir: string;
  let previousAgentMailDir: string | undefined;
  let store: AgentMailStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-mail-restart-'));
    previousAgentMailDir = process.env.AGENT_MAIL_DIR;
    process.env.AGENT_MAIL_DIR = path.join(tmpDir, 'mail');
    store = createAgentMailStore();
  });

  afterEach(() => {
    store.close();
    if (previousAgentMailDir === undefined) delete process.env.AGENT_MAIL_DIR;
    else process.env.AGENT_MAIL_DIR = previousAgentMailDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function startPoller(submitted: string[]) {
    const tasks: Array<() => Promise<void>> = [];
    const handle = startRuntimeInboxPollers({
      agentKey: 'enzo',
      contentRoot: path.join(tmpDir, 'content'),
      events: createRuntimeEventEmitter({ agent: 'enzo', runtime: 'codex', sinks: [] }),
      openBrainConfig: null,
      runtimeLogPath: path.join(tmpDir, 'runtime.log'),
      enqueue: (task) => tasks.push(task),
      discord: { submitPrompt: async () => undefined },
      agentMail: {
        mailStore: store,
        submitPrompt: async (prompt) => { submitted.push(prompt); },
      },
      blueBubbles: { submitPrompt: async () => undefined },
      setIntervalImpl: () => ({} as NodeJS.Timeout),
      clearIntervalImpl: () => undefined,
    });
    return { handle, tasks };
  }

  it('re-injects an old ACKED unanswered request once after restart, while pending_mail_count stays NEW-only', async () => {
    const request = store.send({
      fromAgent: 'marcus',
      toAgent: 'enzo',
      type: 'question',
      subject: 'Old unanswered request',
      bodyMd: 'Please answer after the restart.',
      requiresResponse: true,
    });

    // The old runtime receives and ACKs the request but exits before replying.
    const firstRuntime = startPoller([]);
    firstRuntime.handle.tick();
    expect(firstRuntime.tasks).toHaveLength(1);
    await firstRuntime.tasks.shift()!();
    expect(store.getMessage(request.id)?.status).toBe('acked');
    firstRuntime.handle.stop();

    // pending_mail_count deliberately describes only undelivered NEW mail.
    const handoff = buildRuntimeHandoff({
      agent: 'enzo',
      fromRuntime: 'codex',
      toRuntime: 'codex',
      reason: 'fixture restart',
      workspace: tmpDir,
      contentRoot: path.join(tmpDir, 'content'),
    });
    expect(handoff.pending_mail_count).toBe(0);

    // A fresh poller represents the restarted runtime. The ACKED obligation resurfaces.
    const submitted: string[] = [];
    const restarted = startPoller(submitted);
    restarted.handle.tick();
    expect(restarted.tasks).toHaveLength(1);
    await restarted.tasks.shift()!();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain('[Agent Mail] New message from marcus');
    expect(submitted[0]).toContain('Old unanswered request');

    // Recovery is once per restart, not every poll tick.
    restarted.handle.tick();
    expect(restarted.tasks).toHaveLength(0);
    restarted.handle.stop();

    // Once answered, a later restart must not resurrect the completed obligation.
    store.reply({
      actorAgent: 'enzo',
      messageId: request.id,
      bodyMd: 'Answered.',
    });
    const afterReply = startPoller([]);
    afterReply.handle.tick();
    expect(afterReply.tasks).toHaveLength(0);
    afterReply.handle.stop();
  });
});
