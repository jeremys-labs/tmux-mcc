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
});
