/**
 * Wraps codex prompt injection with the readiness gate plus a bounded unacked-retry budget.
 *
 * The caller acks a delivery only after `deliver` resolves. If the injection window never
 * opens, `deliver` throws {@link CodexInjectionDeferredError} instead of submitting — so the
 * delivery is NOT acked and is redelivered on the next poll. This is retried up to
 * `retryBudget` times; once the budget is spent the prompt is submitted without confirmation
 * (best-effort, at-least-once) rather than being retried forever.
 */
export class CodexInjectionDeferredError extends Error {
  constructor(label: string, id: string, attempts: number) {
    super(`codex injection deferred for ${label} ${id} (attempt ${attempts})`);
    this.name = 'CodexInjectionDeferredError';
  }
}

export interface CodexInjectionGateOptions {
  /** Resolves 'idle' when the codex TUI is ready to receive input, 'timeout' otherwise. */
  waitForWindow: () => Promise<'idle' | 'timeout'>;
  submit: (prompt: string) => Promise<void>;
  /** Number of times a delivery may be deferred before it is submitted without confirmation. */
  retryBudget: number;
  /** Prevents best-effort injection during startup, before Codex has reached its first prompt. */
  canInjectWithoutConfirmation?: () => boolean;
  log?: (line: string) => void;
}

export interface CodexInjectionGate {
  deliver: (prompt: string, id: string, label: string) => Promise<void>;
}

export function createCodexInjectionGate(options: CodexInjectionGateOptions): CodexInjectionGate {
  const { waitForWindow, submit, retryBudget } = options;
  const canInjectWithoutConfirmation = options.canInjectWithoutConfirmation ?? (() => true);
  const log = options.log ?? (() => {});
  const deferrals = new Map<string, number>();

  return {
    async deliver(prompt, id, label) {
      const window = await waitForWindow();

      if (window === 'timeout') {
        const priorDeferrals = deferrals.get(id) ?? 0;
        if (priorDeferrals < retryBudget) {
          const attempts = priorDeferrals + 1;
          deferrals.set(id, attempts);
          log(`codex readiness wait timed out for ${label} ${id}; deferring for retry (attempt ${attempts}/${retryBudget})`);
          throw new CodexInjectionDeferredError(label, id, attempts);
        }
        if (!canInjectWithoutConfirmation()) {
          log(`codex readiness budget exhausted for ${label} ${id}, but startup has not reached a prompt; deferring`);
          throw new CodexInjectionDeferredError(label, id, priorDeferrals + 1);
        }
        log(`codex readiness budget exhausted for ${label} ${id}; injecting without confirmation`);
      }

      deferrals.delete(id);
      log(`injecting ${label} ${id}: ${prompt}`);
      await submit(prompt);
    },
  };
}
