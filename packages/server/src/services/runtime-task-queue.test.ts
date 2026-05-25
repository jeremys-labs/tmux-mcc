import { describe, expect, it } from 'vitest';
import { createRuntimeTaskQueue } from './runtime-task-queue.js';

describe('runtime task queue', () => {
  it('runs tasks serially in enqueue order', async () => {
    const queue = createRuntimeTaskQueue();
    const seen: string[] = [];

    queue.enqueue(async () => {
      seen.push('first:start');
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push('first:end');
    });
    queue.enqueue(async () => {
      seen.push('second');
    });

    await queue.idle();

    expect(seen).toEqual(['first:start', 'first:end', 'second']);
  });

  it('keeps accepting later tasks after a task fails', async () => {
    const queue = createRuntimeTaskQueue();
    const seen: string[] = [];

    queue.enqueue(async () => {
      seen.push('before-failure');
      throw new Error('delivery failed');
    });
    queue.enqueue(async () => {
      seen.push('after-failure');
    });

    await queue.idle();

    expect(seen).toEqual(['before-failure', 'after-failure']);
  });

  // Guards against April-20-class hangs: MCC server was stuck for 5 days after a task
  // entered a hung state (OB1 Obs 9913). Without a timeout, a single wedged task blocks
  // every subsequent task indefinitely with no external signal.
  it('queue continues processing after a stuck task exceeds timeout — guards against April-20-class hangs', async () => {
    const queue = createRuntimeTaskQueue();
    const seen: string[] = [];

    // This task never resolves on its own
    queue.enqueue(
      async () => new Promise<void>(() => { /* intentionally never resolves */ }),
      { timeoutMs: 30 },
    );
    queue.enqueue(async () => {
      seen.push('after-stuck');
    });

    await queue.idle();

    expect(seen).toEqual(['after-stuck']);
  }, 1000);

  it('queueDepth reflects tasks pending and running', async () => {
    const queue = createRuntimeTaskQueue();

    let resolve1!: () => void;
    const blocker = new Promise<void>((r) => { resolve1 = r; });

    queue.enqueue(async () => blocker);
    queue.enqueue(async () => { /* second */ });
    queue.enqueue(async () => { /* third */ });

    // While blocker holds, depth should be 3
    expect(queue.queueDepth()).toBe(3);

    resolve1();
    await queue.idle();

    expect(queue.queueDepth()).toBe(0);
  });
});
