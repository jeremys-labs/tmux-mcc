import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexBridgeInboxEntry } from '../types/codex-bridge.js';
import { readInboxCursor } from './codex-inbox.js';
import {
  deliverRuntimeDiscordInbox,
  enqueuePendingRuntimeDiscordInbox,
} from './runtime-discord-inbox.js';
import { createRuntimeEventEmitter } from './runtime-events.js';
import { buildAnswerContext } from './answer-context.js';

vi.mock('./answer-context.js', async (importActual) => ({
  ...(await importActual<typeof import('./answer-context.js')>()),
  buildAnswerContext: vi.fn(async () => '[Answer Context]\nKnown context.'),
}));

vi.mock('./open-brain-runtime.js', () => ({
  captureDiscordInboxEntry: vi.fn(),
}));

function entry(overrides: Partial<CodexBridgeInboxEntry> = {}): CodexBridgeInboxEntry {
  return {
    id: 'discord_1',
    bindingName: 'enzo',
    agentKey: 'enzo',
    channelId: 'channel_1',
    author: 'Jeremy',
    authorId: 'user_1',
    content: 'Keep going on Enzo.',
    timestamp: '2026-05-12T22:00:00.000Z',
    ...overrides,
  };
}

function writeInbox(contentRoot: string, agentKey: string, entries: CodexBridgeInboxEntry[]): void {
  fs.mkdirSync(path.join(contentRoot, 'bridge', 'inbox'), { recursive: true });
  fs.writeFileSync(
    path.join(contentRoot, 'bridge', 'inbox', `${agentKey}.jsonl`),
    `${entries.map((item) => JSON.stringify(item)).join('\n')}\n`
  );
}

describe('runtime discord inbox delivery', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-discord-inbox-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds context, submits the prompt, then advances the inbox cursor', async () => {
    const order: string[] = [];
    const item = entry();
    writeInbox(tmpDir, 'enzo', [item]);
    const events = createRuntimeEventEmitter({
      agent: 'enzo',
      runtime: 'codex',
      sinks: [(event) => order.push(event.name)],
    });
    const submitPrompt = vi.fn(async (prompt: string) => {
      order.push('submit');
      expect(prompt).toContain('[Answer Context]');
      expect(prompt).toContain('[Messaging Gateway] Discord message routed for enzo.');
    });

    await deliverRuntimeDiscordInbox({
      agentKey: 'enzo',
      contentRoot: tmpDir,
      entry: item,
      events,
      submitPrompt,
      runtimeLogPath: path.join(tmpDir, 'runtime.log'),
    });

    expect(order).toEqual(['onInboundMessage', 'beforeAgentTurn', 'submit', 'afterAgentTurn']);
    expect(readInboxCursor(tmpDir, 'enzo').lineCount).toBe(1);
  });

  it('passes Discord chat and reply-reference metadata into answer-context', async () => {
    const item = entry({
      id: 'reply_1',
      channelId: 'channel_99',
      referencedMessageId: 'scheduled_question_1',
    });
    writeInbox(tmpDir, 'enzo', [item]);

    await deliverRuntimeDiscordInbox({
      agentKey: 'enzo',
      contentRoot: tmpDir,
      entry: item,
      events: createRuntimeEventEmitter({ agent: 'enzo', runtime: 'codex', sinks: [] }),
      submitPrompt: vi.fn(async () => {}),
      runtimeLogPath: path.join(tmpDir, 'runtime.log'),
    });

    expect(buildAnswerContext).toHaveBeenCalledWith(expect.objectContaining({
      agentKey: 'enzo',
      source: 'discord',
      text: 'Keep going on Enzo.',
      chatId: 'channel_99',
      messageId: 'reply_1',
      referencedMessageId: 'scheduled_question_1',
    }));
  });

  it('does not advance the inbox cursor when prompt submission fails', async () => {
    const item = entry();
    writeInbox(tmpDir, 'enzo', [item]);

    await expect(
      deliverRuntimeDiscordInbox({
        agentKey: 'enzo',
        contentRoot: tmpDir,
        entry: item,
        events: createRuntimeEventEmitter({ agent: 'enzo', runtime: 'codex', sinks: [] }),
        submitPrompt: async () => {
          throw new Error('submit failed');
        },
        runtimeLogPath: path.join(tmpDir, 'runtime.log'),
      })
    ).rejects.toThrow('submit failed');

    expect(readInboxCursor(tmpDir, 'enzo').lineCount).toBe(0);
  });

  describe('fast chat lane (env-gated)', () => {
    let latencyDir: string;

    beforeEach(() => {
      latencyDir = path.join(tmpDir, 'latency');
      process.env.DISCORD_FAST_CONTEXT_ENABLED = '1';
      process.env.DISCORD_FAST_CONTEXT_AGENTS = 'enzo';
      process.env.DISCORD_LATENCY_DIR = latencyDir;
    });

    afterEach(() => {
      delete process.env.DISCORD_FAST_CONTEXT_ENABLED;
      delete process.env.DISCORD_FAST_CONTEXT_AGENTS;
      delete process.env.DISCORD_LATENCY_DIR;
    });

    const readTelemetry = () =>
      fs
        .readFileSync(path.join(latencyDir, 'discord-turns.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);

    const deliver = async (item: CodexBridgeInboxEntry, submitted: string[] = []) => {
      writeInbox(tmpDir, 'enzo', [item]);
      await deliverRuntimeDiscordInbox({
        agentKey: 'enzo',
        contentRoot: tmpDir,
        entry: item,
        events: createRuntimeEventEmitter({ agent: 'enzo', runtime: 'codex', sinks: [] }),
        submitPrompt: async (prompt: string) => {
          submitted.push(prompt);
        },
        runtimeLogPath: path.join(tmpDir, 'runtime.log'),
      });
      return submitted;
    };

    it('fast_chat skips buildAnswerContext (no memory recall) and injects the fast context', async () => {
      const submitted = await deliver(
        entry({ id: 'fast_1', content: 'why are my agents slower than ChatGPT?' }),
      );

      expect(buildAnswerContext).not.toHaveBeenCalled();
      expect(submitted[0]).toContain('current_datetime');
      expect(submitted[0]).toContain('runtime_profile');
      expect(submitted[0]).not.toContain('<governed_memory>');
      const [record] = readTelemetry();
      expect(record.lane).toBe('fast_chat');
      expect(record.fastPathUsed).toBe(true);
      expect(typeof record.answerContextMs).toBe('number');
    });

    it('deep_work requests keep using the full buildAnswerContext', async () => {
      await deliver(
        entry({ id: 'deep_1', content: 'please build the fast chat lane in the repo, branch and commit it for review' }),
      );

      expect(buildAnswerContext).toHaveBeenCalledTimes(1);
      const [record] = readTelemetry();
      expect(record.lane).toBe('deep_work');
      expect(record.fastPathUsed).toBe(false);
    });

    it('"did you finish that?" never takes the fast path (Isla regression)', async () => {
      await deliver(entry({ id: 'reg_1', content: 'did you finish that?' }));

      expect(buildAnswerContext).toHaveBeenCalledTimes(1);
      const [record] = readTelemetry();
      expect(record.lane).toBe('personal_context');
      expect(record.fastPathUsed).toBe(false);
    });

    it('stays on the full path for agents outside the allowlist', async () => {
      process.env.DISCORD_FAST_CONTEXT_AGENTS = 'nova';
      await deliver(entry({ id: 'gate_1', content: 'you up?' }));

      expect(buildAnswerContext).toHaveBeenCalledTimes(1);
      const [record] = readTelemetry();
      expect(record.lane).toBe('fast_chat');
      expect(record.fastPathUsed).toBe(false);
    });

    it('attachments force the full path even when the flag is on', async () => {
      await deliver(
        entry({ id: 'att_1', content: 'nice', attachments: [{ url: 'https://x/y.png', filename: 'y.png' }] }),
      );

      expect(buildAnswerContext).toHaveBeenCalledTimes(1);
      const [record] = readTelemetry();
      expect(record.lane).toBe('deep_work');
    });

    it('records telemetry for full-path turns too', async () => {
      delete process.env.DISCORD_FAST_CONTEXT_ENABLED;
      await deliver(entry({ id: 'off_1', content: 'you up?' }));

      expect(buildAnswerContext).toHaveBeenCalledTimes(1);
      const [record] = readTelemetry();
      expect(record.lane).toBe('fast_chat');
      expect(record.fastPathUsed).toBe(false);
    });
  });

  it('dedupes queued pending entries and releases the id on delivery failure', async () => {
    const deliveredIds = new Set<string>();
    const queued: Array<() => Promise<void>> = [];
    const item = entry();
    writeInbox(tmpDir, 'enzo', [item]);

    enqueuePendingRuntimeDiscordInbox({
      agentKey: 'enzo',
      contentRoot: tmpDir,
      deliveredIds,
      events: createRuntimeEventEmitter({ agent: 'enzo', runtime: 'codex', sinks: [] }),
      submitPrompt: async () => {
        throw new Error('runtime unavailable');
      },
      runtimeLogPath: path.join(tmpDir, 'runtime.log'),
      enqueue: (task) => queued.push(task),
    });
    enqueuePendingRuntimeDiscordInbox({
      agentKey: 'enzo',
      contentRoot: tmpDir,
      deliveredIds,
      events: createRuntimeEventEmitter({ agent: 'enzo', runtime: 'codex', sinks: [] }),
      submitPrompt: async () => undefined,
      runtimeLogPath: path.join(tmpDir, 'runtime.log'),
      enqueue: (task) => queued.push(task),
    });

    expect(queued).toHaveLength(1);
    expect(deliveredIds.has('discord_1')).toBe(true);

    await queued[0]();

    expect(deliveredIds.has('discord_1')).toBe(false);
    expect(readInboxCursor(tmpDir, 'enzo').lineCount).toBe(0);
  });
});
