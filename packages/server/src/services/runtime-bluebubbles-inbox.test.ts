import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deliverRuntimeBlueBubblesInbox,
  enqueuePendingRuntimeBlueBubblesInbox,
  formatBlueBubblesEntryForRuntime,
  markBlueBubblesInboxEntryDelivered,
  readPendingBlueBubblesInboxEntries,
  type BlueBubblesInboxEntry,
} from './runtime-bluebubbles-inbox.js';
import { createRuntimeEventEmitter } from './runtime-events.js';

vi.mock('./answer-context.js', () => ({
  buildAnswerContext: vi.fn(async () => '[Answer Context]\nKnown BB context.'),
}));

function entry(overrides: Partial<BlueBubblesInboxEntry> = {}): BlueBubblesInboxEntry {
  return {
    id: 'bb_1',
    chatId: 'any;-;+17072806581',
    sender: '+17072806581',
    content: 'Tell Jeremy the domain is infer3nce.com.',
    ts: '2026-05-18T22:29:10.817Z',
    policy: 'reply',
    attachmentCount: 0,
    ...overrides,
  };
}

function writeInbox(contentRoot: string, entries: BlueBubblesInboxEntry[]): void {
  fs.mkdirSync(path.join(contentRoot, 'bridge', 'bb-inbox'), { recursive: true });
  fs.writeFileSync(
    path.join(contentRoot, 'bridge', 'bb-inbox', 'incoming.jsonl'),
    `${entries.map((item) => JSON.stringify(item)).join('\n')}\n`
  );
}

describe('runtime bluebubbles inbox delivery', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-bluebubbles-inbox-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('reads pending BlueBubbles entries only for the target agent', () => {
    const item = entry();
    writeInbox(tmpDir, [item]);

    expect(readPendingBlueBubblesInboxEntries(tmpDir, 'isla')).toEqual([item]);
    expect(readPendingBlueBubblesInboxEntries(tmpDir, 'eli')).toEqual([]);
  });

  it('allows overriding the target agent with BB_INBOX_AGENT_KEY', () => {
    vi.stubEnv('BB_INBOX_AGENT_KEY', 'eli');
    const item = entry();
    writeInbox(tmpDir, [item]);

    expect(readPendingBlueBubblesInboxEntries(tmpDir, 'isla')).toEqual([]);
    expect(readPendingBlueBubblesInboxEntries(tmpDir, 'eli')).toEqual([item]);
  });

  it('formats the channel envelope with BlueBubbles routing metadata', () => {
    const prompt = formatBlueBubblesEntryForRuntime(entry({ attachmentCount: 1 }));

    expect(prompt).toContain('[Messaging Gateway] BlueBubbles message routed for isla.');
    expect(prompt).toContain('source="bluebubbles"');
    expect(prompt).toContain('chat_id="any;-;+17072806581"');
    expect(prompt).toContain('policy="reply"');
    expect(prompt).toContain('attachment_count="1"');
  });

  it('builds context, submits the prompt, then advances the inbox cursor', async () => {
    const order: string[] = [];
    const item = entry();
    writeInbox(tmpDir, [item]);
    const events = createRuntimeEventEmitter({
      agent: 'isla',
      runtime: 'claude',
      sinks: [(event) => order.push(event.name)],
    });
    const submitPrompt = vi.fn(async (prompt: string) => {
      order.push('submit');
      expect(prompt).toContain('[Answer Context]');
      expect(prompt).toContain('[Messaging Gateway] BlueBubbles message routed for isla.');
    });

    await deliverRuntimeBlueBubblesInbox({
      agentKey: 'isla',
      contentRoot: tmpDir,
      entry: item,
      events,
      submitPrompt,
      runtimeLogPath: path.join(tmpDir, 'runtime.log'),
    });

    expect(order).toEqual(['onInboundMessage', 'beforeAgentTurn', 'submit', 'afterAgentTurn']);
    expect(readPendingBlueBubblesInboxEntries(tmpDir, 'isla')).toEqual([]);
  });

  it('does not advance the cursor when prompt submission fails', async () => {
    const item = entry();
    writeInbox(tmpDir, [item]);

    await expect(
      deliverRuntimeBlueBubblesInbox({
        agentKey: 'isla',
        contentRoot: tmpDir,
        entry: item,
        events: createRuntimeEventEmitter({ agent: 'isla', runtime: 'claude', sinks: [] }),
        submitPrompt: async () => {
          throw new Error('submit failed');
        },
        runtimeLogPath: path.join(tmpDir, 'runtime.log'),
      })
    ).rejects.toThrow('submit failed');

    expect(markBlueBubblesInboxEntryDelivered(tmpDir, 'isla', item)).toBe(true);
  });

  it('dedupes queued pending entries and releases the id on delivery failure', async () => {
    const deliveredIds = new Set<string>();
    const queued: Array<() => Promise<void>> = [];
    const item = entry();
    writeInbox(tmpDir, [item]);

    enqueuePendingRuntimeBlueBubblesInbox({
      agentKey: 'isla',
      contentRoot: tmpDir,
      deliveredIds,
      events: createRuntimeEventEmitter({ agent: 'isla', runtime: 'claude', sinks: [] }),
      submitPrompt: async () => {
        throw new Error('runtime unavailable');
      },
      runtimeLogPath: path.join(tmpDir, 'runtime.log'),
      enqueue: (task) => queued.push(task),
    });
    enqueuePendingRuntimeBlueBubblesInbox({
      agentKey: 'isla',
      contentRoot: tmpDir,
      deliveredIds,
      events: createRuntimeEventEmitter({ agent: 'isla', runtime: 'claude', sinks: [] }),
      submitPrompt: async () => undefined,
      runtimeLogPath: path.join(tmpDir, 'runtime.log'),
      enqueue: (task) => queued.push(task),
    });

    expect(queued).toHaveLength(1);
    expect(deliveredIds.has('bb_1')).toBe(true);

    await queued[0]();

    expect(deliveredIds.has('bb_1')).toBe(false);
    expect(readPendingBlueBubblesInboxEntries(tmpDir, 'isla')).toEqual([item]);
  });
});
