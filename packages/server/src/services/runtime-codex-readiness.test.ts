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


const STATIC_BUSY_FRAMES = 20;

// ---------------------------------------------------------------------------
// Busy-marker change rule. GUARDRAILS FIRST, deliberately: a decay whose only
// proven branch is the one that RELEASES the pin has no teeth in the direction
// that costs us silently. Tests 1-6 all assert the gate does NOT release.
// ---------------------------------------------------------------------------
describe('codex readiness — a busy marker must CHANGE to hold the gate', () => {
  const frame = (line: string) => `${line}\n› \n`;

  it('1. silence is not evidence of idle — data stops cold and the gate holds', async () => {
    const gate = createCodexReadinessGate();
    gate.onData(frame('Working (12s • esc to interrupt)'));
    // No further data at all. Nothing is evaluated, so nothing can conclude idle.
    let resolved = false;
    void gate.waitForIdle().then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it('2. streaming non-prompt output does not release a working agent', async () => {
    const gate = createCodexReadinessGate();
    gate.onData(frame('Working (12s • esc to interrupt)'));
    for (let i = 0; i < 50; i += 1) gate.onData(`tool output chunk ${i}\n`);
    let resolved = false;
    void gate.waitForIdle().then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it('3. genuine work — a changing counter stays busy well past the limit', async () => {
    const gate = createCodexReadinessGate();
    for (let i = 0; i < STATIC_BUSY_FRAMES * 3; i += 1) {
      gate.onData(frame(`Working (${i}s • esc to interrupt)`));
    }
    let resolved = false;
    void gate.waitForIdle().then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it('4. genuine work — an animating spinner stays busy (the unit is the LINE, not the glyph)', async () => {
    const gate = createCodexReadinessGate();
    const glyphs = ['✱', '✻', '✽'];
    for (let i = 0; i < STATIC_BUSY_FRAMES * 3; i += 1) {
      gate.onData(frame(`${glyphs[i % 3]} Thinking`));
    }
    let resolved = false;
    void gate.waitForIdle().then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it('5. a busy line split across two chunks is compared once, whole', async () => {
    const gate = createCodexReadinessGate();
    // Same logical line every frame, but the CHUNK boundary moves. Comparing partials would
    // see a different string each time and never release; comparing complete lines releases.
    for (let i = 0; i < STATIC_BUSY_FRAMES + 2; i += 1) {
      gate.onData('✻ Think');
      gate.onData('ing\n› \n');
    }
    await expect(gate.waitForIdle()).resolves.toBeUndefined();
  });

  it('6. an over-long fragment is an ABSENCE of an observation — state unchanged, no comparison', async () => {
    const notices: string[] = [];
    const gate = createCodexReadinessGate({ onNotice: (m) => notices.push(m) });
    gate.onData(frame('Working (12s • esc to interrupt)'));
    gate.onData('x'.repeat(9000)); // no newline anywhere
    let resolved = false;
    void gate.waitForIdle().then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(notices.some((m) => m.startsWith('oversized-fragment-dropped'))).toBe(true);
  });

  it('6b. cap exceeded DROPS the fragment — trimming it would rejoin a truncated head to the next line', async () => {
    // probe-mutate found that test 6 could NOT see the difference between dropping and
    // trimming: both hold the gate, so the assertion proved nothing about Isla's residual.
    // This one discriminates. Each frame overflows the cap with DIFFERENT filler, then sends
    // an identical busy tail. Under DROP the completed line is exactly the busy tail every
    // time -> identical -> releases. Under TRIM the retained filler is prepended, the line
    // differs every frame, and it never releases. Asserting the release is what makes the
    // trim variant red.
    const gate = createCodexReadinessGate();
    for (let i = 0; i < STATIC_BUSY_FRAMES + 1; i += 1) {
      gate.onData(String.fromCharCode(97 + (i % 26)).repeat(9000)); // no newline: overflows
      gate.onData('✻ Thinking\n› \n');
    }
    await expect(gate.waitForIdle()).resolves.toBeUndefined();
  });

  it('7. THE CLASS REGRESSION — a byte-identical busy line releases and names itself', async () => {
    // Descends from the 2026-08-24 incident rather than reproducing it: that incident's own
    // line ("• You have 1 usage limit reset available.") no longer classifies busy at all
    // after 03e2d6e, so it would be green against current code and prove nothing.
    const transitions: Array<[string, string]> = [];
    const gate = createCodexReadinessGate({ onTransition: (s, m) => transitions.push([s, m]) });
    for (let i = 0; i < STATIC_BUSY_FRAMES + 1; i += 1) gate.onData(frame('✻ Thinking'));
    await expect(gate.waitForIdle()).resolves.toBeUndefined();
    const release = transitions.find(([s]) => s === 'idle');
    expect(release?.[1]).toContain('static-busy-line');
    expect(release?.[1]).toContain('✻ Thinking');
  });

  it('8. queued-input never participates in the rule', async () => {
    const gate = createCodexReadinessGate();
    for (let i = 0; i < STATIC_BUSY_FRAMES * 2; i += 1) {
      gate.onData('Messages to be submitted after next tool call\n');
    }
    let resolved = false;
    void gate.waitForIdle().then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it('9. the logged line is bounded and control-stripped, but the COMPARISON uses the full line', async () => {
    const transitions: Array<[string, string]> = [];
    const gate = createCodexReadinessGate({ onTransition: (s, m) => transitions.push([s, m]) });
    const long = `✻ Thinking ${'y'.repeat(600)}`;
    for (let i = 0; i < STATIC_BUSY_FRAMES + 1; i += 1) gate.onData(frame(long));
    await expect(gate.waitForIdle()).resolves.toBeUndefined();
    const release = transitions.find(([s]) => s === 'idle')?.[1] ?? '';
    expect(release.length).toBeLessThan(400);
    expect(release).toContain('digest');
  });
});
