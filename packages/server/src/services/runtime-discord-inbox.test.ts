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

vi.mock('./answer-context.js', () => ({
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
