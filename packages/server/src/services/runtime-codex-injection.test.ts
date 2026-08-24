import { describe, expect, it, vi } from 'vitest';
import {
  createCodexInjectionGate,
  CodexInjectionDeferredError,
} from './runtime-codex-injection.js';

describe('createCodexInjectionGate', () => {
  it('submits when the injection window is open', async () => {
    const submit = vi.fn(async () => {});
    const gate = createCodexInjectionGate({
      waitForWindow: async () => 'idle',
      submit,
      retryBudget: 3,
    });

    await gate.deliver('hello', 'msg-1', 'discord');

    expect(submit).toHaveBeenCalledWith('hello');
  });

  it('defers (throws, does not submit) while the retry budget remains', async () => {
    const submit = vi.fn(async () => {});
    const gate = createCodexInjectionGate({
      waitForWindow: async () => 'timeout',
      submit,
      retryBudget: 2,
    });

    await expect(gate.deliver('hi', 'msg-1', 'mail')).rejects.toBeInstanceOf(CodexInjectionDeferredError);
    await expect(gate.deliver('hi', 'msg-1', 'mail')).rejects.toBeInstanceOf(CodexInjectionDeferredError);
    expect(submit).not.toHaveBeenCalled();
  });

  it('injects without confirmation once the retry budget is exhausted', async () => {
    const submit = vi.fn(async () => {});
    const gate = createCodexInjectionGate({
      waitForWindow: async () => 'timeout',
      submit,
      retryBudget: 2,
    });

    await expect(gate.deliver('hi', 'msg-1', 'discord')).rejects.toBeInstanceOf(CodexInjectionDeferredError);
    await expect(gate.deliver('hi', 'msg-1', 'discord')).rejects.toBeInstanceOf(CodexInjectionDeferredError);
    // Third attempt: budget spent, submit anyway rather than lose the message forever.
    await gate.deliver('hi', 'msg-1', 'discord');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith('hi');
  });

  it('tracks the retry budget per message id', async () => {
    const submit = vi.fn(async () => {});
    const gate = createCodexInjectionGate({
      waitForWindow: async () => 'timeout',
      submit,
      retryBudget: 1,
    });

    await expect(gate.deliver('a', 'msg-1', 'discord')).rejects.toBeInstanceOf(CodexInjectionDeferredError);
    // A different id starts its own budget rather than inheriting msg-1's.
    await expect(gate.deliver('b', 'msg-2', 'discord')).rejects.toBeInstanceOf(CodexInjectionDeferredError);
    expect(submit).not.toHaveBeenCalled();
  });

  it('clears the retry counter after a confirmed delivery', async () => {
    const submit = vi.fn(async () => {});
    let window: 'idle' | 'timeout' = 'timeout';
    const gate = createCodexInjectionGate({
      waitForWindow: async () => window,
      submit,
      retryBudget: 2,
    });

    await expect(gate.deliver('x', 'msg-1', 'discord')).rejects.toBeInstanceOf(CodexInjectionDeferredError);
    window = 'idle';
    await gate.deliver('x', 'msg-1', 'discord');
    expect(submit).toHaveBeenCalledTimes(1);

    // Counter reset: a later timeout for the same id gets the full budget again.
    window = 'timeout';
    await expect(gate.deliver('x', 'msg-1', 'discord')).rejects.toBeInstanceOf(CodexInjectionDeferredError);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('never forces an injection before Codex reaches its first prompt', async () => {
    let reachedPrompt = false;
    const submit = vi.fn(async () => {});
    const gate = createCodexInjectionGate({
      waitForWindow: async () => 'timeout',
      submit,
      retryBudget: 1,
      canInjectWithoutConfirmation: () => reachedPrompt,
    });

    await expect(gate.deliver('startup message', 'm-start', 'mail')).rejects.toThrow(CodexInjectionDeferredError);
    await expect(gate.deliver('startup message', 'm-start', 'mail')).rejects.toThrow(CodexInjectionDeferredError);
    expect(submit).not.toHaveBeenCalled();

    reachedPrompt = true;
    await expect(gate.deliver('startup message', 'm-start', 'mail')).resolves.toBeUndefined();
    expect(submit).toHaveBeenCalledWith('startup message');
  });
});

describe('never-ready runtime reports a fault instead of deferring silently forever', () => {
  // 2026-08-24: the retry budget bounded each DELIVERY but nothing bounded the STATE.
  // Eli's runtime sat undeliverable for seven hours emitting the same deferral line
  // 171,655 times, and no monitoring anywhere fired, because "not ready yet" and
  // "never going to be ready" are the same string.
  const neverReady = () => false;

  it('reports a FAULT once after the threshold, and does not repeat it', async () => {
    const lines: string[] = [];
    const gate = createCodexInjectionGate({
      waitForWindow: async () => 'timeout',
      submit: async () => {},
      retryBudget: 1,
      canInjectWithoutConfirmation: neverReady,
      neverReadyFaultThreshold: 3,
      log: (line) => lines.push(line),
    });

    for (let i = 0; i < 8; i += 1) {
      await expect(gate.deliver('p', `id-${i}`, 'mail')).rejects.toThrow();
      await expect(gate.deliver('p', `id-${i}`, 'mail')).rejects.toThrow();
    }

    const faults = lines.filter((line) => line.startsWith('FAULT:'));
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain('has not reached a prompt after 3 consecutive deferrals');
  });

  it('does not report a fault when the runtime is merely busy but reachable', async () => {
    const lines: string[] = [];
    const gate = createCodexInjectionGate({
      waitForWindow: async () => 'timeout',
      submit: async () => {},
      retryBudget: 1,
      canInjectWithoutConfirmation: () => true,
      neverReadyFaultThreshold: 2,
      log: (line) => lines.push(line),
    });

    for (let i = 0; i < 6; i += 1) {
      await expect(gate.deliver('p', `id-${i}`, 'mail')).rejects.toThrow();
      await gate.deliver('p', `id-${i}`, 'mail');
    }

    expect(lines.filter((line) => line.startsWith('FAULT:'))).toHaveLength(0);
  });

  it('a successful injection clears the streak, so a later stall re-reports', async () => {
    const lines: string[] = [];
    let ready = false;
    const gate = createCodexInjectionGate({
      waitForWindow: async () => 'timeout',
      submit: async () => {},
      retryBudget: 0,
      canInjectWithoutConfirmation: () => ready,
      neverReadyFaultThreshold: 2,
      log: (line) => lines.push(line),
    });

    await expect(gate.deliver('p', 'a', 'mail')).rejects.toThrow();
    await expect(gate.deliver('p', 'b', 'mail')).rejects.toThrow();
    expect(lines.filter((l) => l.startsWith('FAULT:'))).toHaveLength(1);

    ready = true;
    await gate.deliver('p', 'c', 'mail');

    ready = false;
    await expect(gate.deliver('p', 'd', 'mail')).rejects.toThrow();
    await expect(gate.deliver('p', 'e', 'mail')).rejects.toThrow();
    expect(lines.filter((l) => l.startsWith('FAULT:'))).toHaveLength(2);
  });
});
