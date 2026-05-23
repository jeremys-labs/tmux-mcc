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
