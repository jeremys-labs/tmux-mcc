import crypto from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCodexReadinessGate } from './runtime-codex-readiness.js';

interface CaptureChunk {
  sequence: number;
  byteLength: number;
  sha256: string;
  dataBase64: string;
}

interface CaptureFixture {
  chunks: CaptureChunk[];
  sanitization: {
    sanitizedByteLength: number;
    redactions: Array<{ occurrences: number }>;
  };
}

const fixture = JSON.parse(
  fs.readFileSync(new URL('./__fixtures__/codex-readiness-v0.151.0-final-prompt.json', import.meta.url), 'utf8'),
) as CaptureFixture;

function decode(chunk: CaptureChunk): string {
  const bytes = Buffer.from(chunk.dataBase64, 'base64');
  expect(bytes).toHaveLength(chunk.byteLength);
  expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(chunk.sha256);
  return bytes.toString('utf8');
}

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

describe('Codex v0.151.0 bounded raw-chunk reproduction', () => {
  // `it.fails` rather than `it`: this is a REPRODUCTION of an open bug, and a reproduction
  // that lands on main as a plain failing test makes the suite permanently red -- which is the
  // loudest possible version of a check nobody reads, because it trains everyone to skip the
  // whole report. Asserting that it FAILS keeps the bug machine-checked instead: the suite is
  // green while the bug is open, and goes RED the moment someone fixes the gate without
  // updating this file. The known-bad state becomes an assertion rather than noise.
  it.fails('RED: releases waitForIdle after the final prompt is visibly rendered', async () => {
    expect(fixture.chunks).toHaveLength(899);
    expect(fixture.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(
      fixture.sanitization.sanitizedByteLength,
    );
    expect(fixture.sanitization.redactions.some((redaction) => redaction.occurrences > 0)).toBe(true);

    const transitions: Array<[string, string]> = [];
    const gate = createCodexReadinessGate({
      onTransition: (state, marker) => transitions.push([state, marker]),
    });
    let waiter: Promise<void> | undefined;

    for (const chunk of fixture.chunks) {
      gate.onData(decode(chunk));
      if (!waiter && transitions.some(([state]) => state === 'busy')) waiter = gate.waitForIdle();
    }

    expect(waiter).toBeDefined();
    expect(transitions).toContainEqual(['busy', 'working']);
    expect(transitions).not.toContainEqual(['idle', 'prompt-ready']);

    const finalScreenUpdate = decode(fixture.chunks[894]);
    const flattened = stripAnsi(finalScreenUpdate);
    expect(flattened).toContain('CODEX_READINESS_CAPTURE_DONE_20260904');
    expect(flattened).toContain('› Ask Codex to do anything');
    expect(flattened.includes('\n› ') || flattened.startsWith('› ')).toBe(false);

    const outcome = await Promise.race([
      waiter!.then(() => 'idle' as const),
      new Promise<'still-busy'>((resolve) => setTimeout(() => resolve('still-busy'), 20)),
    ]);

    // Expected RED on the current parser: the independently captured tmux pane shows
    // the final prompt, but cursor-addressed output leaves the gate stuck busy.
    expect(outcome).toBe('idle');
  });
});

describe('same-callback busy precedence controls', () => {
  it('keeps queued-input busy when a prompt appears earlier in the same callback', async () => {
    const gate = createCodexReadinessGate();
    gate.onData('• Working (1s • esc to interrupt)');
    let resolved = false;
    void gate.waitForIdle().then(() => { resolved = true; });

    gate.onData('\n› Ask Codex to do anything\nMessages to be submitted after next tool call');
    await Promise.resolve();

    expect(gate.hasReachedPrompt()).toBe(true);
    expect(resolved).toBe(false);
  });

  it('keeps later working evidence busy when a prompt appears earlier in the same callback', async () => {
    const gate = createCodexReadinessGate();
    gate.onData('• Working (1s • esc to interrupt)');
    let resolved = false;
    void gate.waitForIdle().then(() => { resolved = true; });

    gate.onData('\n› Ask Codex to do anything\n• Working (2s • esc to interrupt)');
    await Promise.resolve();

    expect(gate.hasReachedPrompt()).toBe(true);
    expect(resolved).toBe(false);
  });
});
