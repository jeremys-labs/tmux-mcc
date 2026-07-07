import { describe, expect, it, vi } from 'vitest';
import { createStdinGate } from './runtime-stdin-gate.js';

describe('createStdinGate', () => {
  it('forwards user input immediately when no injection is in flight', () => {
    const writes: string[] = [];
    const gate = createStdinGate((data) => writes.push(data));

    gate.passthrough('a');
    gate.passthrough('b');

    expect(writes).toEqual(['a', 'b']);
  });

  it('buffers user input during an injection and flushes it afterward', async () => {
    const writes: string[] = [];
    const gate = createStdinGate((data) => writes.push(data));

    const injection = gate.run(async () => {
      writes.push('<injected>');
    });
    // User types mid-injection — must not interleave into the injection sequence.
    gate.passthrough('x');
    gate.passthrough('y');

    await injection;

    expect(writes).toEqual(['<injected>', 'xy']);
  });

  it('only flushes once the outermost injection completes', async () => {
    const writes: string[] = [];
    const gate = createStdinGate((data) => writes.push(data));

    let releaseInner!: () => void;
    const inner = new Promise<void>((r) => { releaseInner = r; });

    const outer = gate.run(async () => {
      await gate.run(async () => inner);
    });
    gate.passthrough('z');

    releaseInner();
    await outer;

    expect(writes).toEqual(['z']);
  });

  it('flushes buffered input even if the injection throws', async () => {
    const writes: string[] = [];
    const gate = createStdinGate((data) => writes.push(data));

    const run = gate.run(async () => {
      throw new Error('inject failed');
    });
    gate.passthrough('q');

    await expect(run).rejects.toThrow('inject failed');
    expect(writes).toEqual(['q']);
  });
});
