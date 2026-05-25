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

export function createRuntimeTaskQueue(): RuntimeTaskQueue {
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
      const wrapped = opts?.timeoutMs ? withTimeout(task, opts.timeoutMs) : task;
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
