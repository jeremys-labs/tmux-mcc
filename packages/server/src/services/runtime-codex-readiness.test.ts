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

describe('a bare bullet is content, not a spinner frame', () => {
  // Residual from the 2026-08-24 deadlock. Making reachedPrompt monotonic un-stuck the
  // injection gate, but Eli was then pinned BUSY forever: exactly one gate transition
  // after his restart — "-> busy (working)" at 13:32:34 — and never back to idle, because
  // the persistent "• You have 1 usage limit reset available." line re-matched the glyph
  // pattern on every redraw. waitForIdle() could never resolve.
  //
  // `•` is not a spinner frame. Cecelia's pane carries "• Cecelia's quick wrap-up" as
  // ordinary prose, which is independent evidence the character appears in content. The
  // spinner frames (✱✻✽) stay, and `Working (` remains the primary busy signal — so a
  // genuinely working TUI is still detected even if some build does use a bullet.
  //
  // This is narrowing, which I argued against for the ordering fix, and the distinction is
  // the point: dropping a character that was never a spinner is not the same as
  // enumerating the notices we happen to have seen. A denylist of notices would reopen on
  // the next TUI restyle; this does not.
  it('does not go busy on a static bullet notice', () => {
    const transitions: Array<[string, string]> = [];
    const gate = createCodexReadinessGate({
      onTransition: (state, marker) => transitions.push([state, marker]),
    });
    gate.onData('• You have 1 usage limit reset available. Run /usage to use one.\n');
    expect(transitions).toEqual([]);
  });

  it('does not go busy on bullet-prefixed prose', () => {
    const transitions: Array<[string, string]> = [];
    const gate = createCodexReadinessGate({
      onTransition: (state, marker) => transitions.push([state, marker]),
    });
    gate.onData('• Cecelia’s quick wrap-up\n');
    expect(transitions).toEqual([]);
  });

  it('still goes busy on a real spinner frame', () => {
    const transitions: Array<[string, string]> = [];
    const gate = createCodexReadinessGate({
      onTransition: (state, marker) => transitions.push([state, marker]),
    });
    gate.onData('✻ Thinking\n');
    expect(transitions).toEqual([['busy', 'working']]);
  });

  it('still goes busy on Working (, which is the primary signal', () => {
    const transitions: Array<[string, string]> = [];
    const gate = createCodexReadinessGate({
      onTransition: (state, marker) => transitions.push([state, marker]),
    });
    gate.onData('• a bullet notice and then Working (12s)\n');
    expect(transitions).toEqual([['busy', 'working']]);
  });

  it('a notice-only redraw leaves the gate idle so waitForIdle resolves', async () => {
    const gate = createCodexReadinessGate();
    gate.onData('\n› ');
    gate.onData('• You have 1 usage limit reset available.\n');
    await expect(gate.waitForIdle()).resolves.toBeUndefined();
  });
});
