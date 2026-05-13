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
});
