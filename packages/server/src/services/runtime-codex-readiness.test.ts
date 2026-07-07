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
