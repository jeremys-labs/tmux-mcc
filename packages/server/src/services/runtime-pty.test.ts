import { describe, expect, it } from 'vitest';
import { submitRuntimePrompt } from './runtime-pty.js';

describe('runtime pty', () => {
  it('clears the input line, writes the prompt, then submits', async () => {
    const writes: string[] = [];

    await submitRuntimePrompt(
      { write: (data) => writes.push(data) },
      'hello runtime',
      { clearDelayMs: 0, submitDelayMs: 0 },
    );

    expect(writes).toEqual(['\x15', 'hello runtime', '\r']);
  });

  it('can write prompts in chunks before submitting', async () => {
    const writes: string[] = [];

    await submitRuntimePrompt(
      { write: (data) => writes.push(data) },
      'abcdef',
      { clearDelayMs: 0, submitDelayMs: 0, chunkSize: 2, chunkDelayMs: 0 },
    );

    expect(writes).toEqual(['\x15', 'ab', 'cd', 'ef', '\r']);
  });
});

// 2026-09-13: Discord messages to Remy were injected, logged `submitted`, and never
// appeared in his TUI. Correlation across his injection journal is unambiguous:
// promptLength 1680/1714/1752/1918 delivered; 3365 and 3397 were BOTH lost and
// re-delivered by the reconciler 12 minutes later with byte-identical length, and
// 5289 never arrived. The defaults wrote the whole prompt in one `term.write()` and
// waited 80ms before `\r`, so a large paste outran the TUI's ingest and the Enter
// landed on an incomplete buffer. The `submitDelayMs: 250` already hardcoded at the
// handoff call site was the same bug, fixed for one caller only.
describe('runtime pty — a large prompt must not outrun the terminal', () => {
  it('chunks a prompt larger than the default chunk size instead of one write', async () => {
    const writes: string[] = [];
    const prompt = 'x'.repeat(3397);

    await submitRuntimePrompt({ write: (data) => writes.push(data) }, prompt, {
      clearDelayMs: 0,
      chunkDelayMs: 0,
      submitDelayMs: 0,
    });

    const body = writes.slice(1, -1);
    expect(body.length).toBeGreaterThan(1);
    expect(body.join('')).toBe(prompt);
    expect(writes[0]).toBe('\x15');
    expect(writes[writes.length - 1]).toBe('\r');
  });

  it('scales the pre-submit delay with prompt size rather than a flat 80ms', async () => {
    const waits: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    // @ts-expect-error test double
    globalThis.setTimeout = (fn: () => void, ms?: number) => { waits.push(ms ?? 0); fn(); return 0; };
    try {
      await submitRuntimePrompt({ write: () => {} }, 'y'.repeat(5289), { clearDelayMs: 0, chunkDelayMs: 0 });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    // The last wait is the pre-Enter delay.
    expect(waits[waits.length - 1]).toBeGreaterThanOrEqual(250);
  });

  it('leaves a short prompt as a single write, so existing behaviour is unchanged', async () => {
    const writes: string[] = [];
    await submitRuntimePrompt({ write: (data) => writes.push(data) }, 'hello', {
      clearDelayMs: 0,
      submitDelayMs: 0,
    });
    expect(writes).toEqual(['\x15', 'hello', '\r']);
  });
});
