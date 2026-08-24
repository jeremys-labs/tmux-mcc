import { describe, expect, it, vi } from 'vitest';
import { createCodexReadinessGate } from './runtime-codex-readiness.js';

describe('Codex readiness gate', () => {
  it('reports only real busy/idle transitions to the log hook', () => {
    const onTransition = vi.fn();
    const gate = createCodexReadinessGate({ onTransition });

    gate.onData('• Working (12s • esc to interrupt)');
    gate.onData('• Working (13s • esc to interrupt)'); // still busy, no new transition
    gate.onData('\n› ');
    gate.onData('\n› '); // still idle, no new transition

    expect(onTransition.mock.calls).toEqual([
      ['busy', 'working'],
      ['idle', 'prompt-ready'],
    ]);
  });

  it('resolves immediately while idle', async () => {
    const gate = createCodexReadinessGate();

    expect(gate.hasReachedPrompt()).toBe(false);
    await expect(gate.waitForIdle()).resolves.toBeUndefined();
  });

  it('waits while Codex is working and resolves when the prompt returns', async () => {
    const gate = createCodexReadinessGate();
    gate.onData('• Working (12s • esc to interrupt)');

    let resolved = false;
    const wait = gate.waitForIdle().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    gate.onData('\n────────────────\n› Write tests for @filename\n');
    await wait;
    expect(gate.hasReachedPrompt()).toBe(true);
    expect(resolved).toBe(true);
  });

  it('treats Codex queued-input mode as busy', async () => {
    const gate = createCodexReadinessGate();
    gate.onData('Messages to be submitted after next tool call');

    let resolved = false;
    const wait = gate.waitForIdle().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    gate.onData('\n› ');
    await wait;
    expect(resolved).toBe(true);
  });
});

describe('prompt detection is not blocked by a static busy-looking notice', () => {
  // REAL INCIDENT, 2026-08-24. Eli's Codex TUI carries a persistent bullet line:
  //   "• You have 1 usage limit reset available. Run /usage to use one."
  // It matches the busy glyph regex, and the busy branch returned before the prompt
  // check ever ran. On a full-screen redraw the notice and the prompt arrive in one
  // chunk, so reachedPrompt never became true, canInjectWithoutConfirmation() stayed
  // false, and EVERY inbound message deferred forever: 4 mails queued unread and
  // 171,655 readiness lines in his runtime log. Only Eli, because he was the only
  // agent whose TUI showed that notice.
  const USAGE_NOTICE = '• You have 1 usage limit reset available. Run /usage to use one.';

  it('reaches the prompt when a redraw carries the notice and the prompt together', () => {
    const gate = createCodexReadinessGate();
    gate.onData(`${USAGE_NOTICE}\n› \n`);
    expect(gate.hasReachedPrompt()).toBe(true);
  });

  it('reaches the prompt when the notice arrives in its own chunk first', () => {
    const gate = createCodexReadinessGate();
    gate.onData(`${USAGE_NOTICE}\n`);
    gate.onData('\n› ');
    expect(gate.hasReachedPrompt()).toBe(true);
  });

  it('still reports busy while genuinely working, with no prompt in the chunk', () => {
    const gate = createCodexReadinessGate();
    gate.onData('› ');
    expect(gate.hasReachedPrompt()).toBe(true);
    gate.onData('✻ Working (12s)\n');
    let idle = false;
    void gate.waitForIdle().then(() => { idle = true; });
    expect(idle).toBe(false);
  });

  it('once the prompt is reached it stays reached — reachedPrompt is monotonic', () => {
    const gate = createCodexReadinessGate();
    gate.onData('\n› ');
    gate.onData('✻ Working (3s)\n');
    gate.onData(`${USAGE_NOTICE}\n`);
    expect(gate.hasReachedPrompt()).toBe(true);
  });
});
