export type RuntimeTask = () => Promise<void>;

export interface EnqueueOptions {
  /** Maximum ms to wait for this task before abandoning it and continuing the chain. */
  timeoutMs?: number;
  /**
   * Called if the task is abandoned because it exceeded its timeout. A timed-out task keeps
   * running detached, so its own try/catch never gets to clean up — this hook lets the enqueuer
   * run that cleanup (e.g. release a dedup id so the delivery is retried) at the queue level.
   */
  onTimeout?: () => void;
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

  function withTimeout(task: RuntimeTask, timeoutMs: number, onTimeout?: () => void): RuntimeTask {
    return () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
          // Fire cleanup before the race rejects so the id is released before the chain moves on.
          onTimeout?.();
          reject(new Error(`Task timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });
      // Clearing the timer when the task settles first both stops the leak and guarantees
      // onTimeout never runs for a task that actually completed.
      return Promise.race([task(), timeout]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    };
  }

  return {
    enqueue(task, opts) {
      depth += 1;
      const timeoutMs = opts?.timeoutMs ?? options.defaultTimeoutMs;
      const wrapped = timeoutMs ? withTimeout(task, timeoutMs, opts?.onTimeout) : task;
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
