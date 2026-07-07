export type RuntimeTask = () => Promise<void>;

export interface EnqueueOptions {
  /** Maximum ms to wait for this task before abandoning it and continuing the chain. */
  timeoutMs?: number;
}

export interface RuntimeTaskQueue {
  enqueue(task: RuntimeTask, opts?: EnqueueOptions): void;
  /** Number of tasks currently queued (includes the running task). */
  queueDepth(): number;
  idle(): Promise<void>;
}

export interface CreateRuntimeTaskQueueOptions {
  /**
   * Default per-task timeout applied when `enqueue` is not given an explicit `timeoutMs`.
   * Guards against one hung injection task (e.g. a wedged network call) head-of-line-blocking
   * every subsequent handoff and inbox delivery for the life of the pane.
   */
  defaultTimeoutMs?: number;
}

export function createRuntimeTaskQueue(options: CreateRuntimeTaskQueueOptions = {}): RuntimeTaskQueue {
  let chain: Promise<void> = Promise.resolve();
  let depth = 0;

  function withTimeout(task: RuntimeTask, timeoutMs: number): RuntimeTask {
    return () =>
      Promise.race([
        task(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error(`Task timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
  }

  return {
    enqueue(task, opts) {
      depth += 1;
      const timeoutMs = opts?.timeoutMs ?? options.defaultTimeoutMs;
      const wrapped = timeoutMs ? withTimeout(task, timeoutMs) : task;
      chain = chain
        .then(wrapped)
        .catch(() => undefined)
        .finally(() => {
          depth -= 1;
        });
    },
    queueDepth() {
      return depth;
    },
    idle() {
      return chain;
    },
  };
}
