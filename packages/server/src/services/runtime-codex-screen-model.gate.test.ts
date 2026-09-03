import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type * as Headless from '@xterm/headless';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof Headless;

const fixtureUrl = new URL('./__fixtures__/codex-readiness-v0.151.0-final-prompt.json', import.meta.url);
const goldenUrl = new URL('./__fixtures__/codex-readiness-v0.151.0-xterm-6.0.0-golden.json', import.meta.url);
const manifestUrl = new URL('./__fixtures__/codex-readiness-evidence-manifest.json', import.meta.url);

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

describe('@xterm/headless Friday acceptance gate', () => {
  it('imports in the server and deterministically reconstructs the pinned final viewport', async () => {
    const fixtureBytes = fs.readFileSync(fixtureUrl);
    const goldenBytes = fs.readFileSync(goldenUrl);
    const fixture = JSON.parse(fixtureBytes.toString('utf8'));
    const golden = JSON.parse(goldenBytes.toString('utf8'));
    const manifest = JSON.parse(fs.readFileSync(manifestUrl, 'utf8'));

    expect(sha256(fixtureBytes)).toBe(manifest.streamFixture.fileSha256);
    expect(sha256(goldenBytes)).toBe(manifest.renderedGolden.fileSha256);
    expect(fixture.chunks).toHaveLength(manifest.streamFixture.callbackCount);

    const terminal = new Terminal(golden.renderer.options);
    for (const chunk of fixture.chunks) {
      await new Promise<void>((resolve) => {
        terminal.write(Buffer.from(chunk.dataBase64, 'base64'), resolve);
      });
    }

    const buffer = terminal.buffer.active;
    const lines = Array.from({ length: terminal.rows }, (_, row) =>
      buffer.getLine(buffer.viewportY + row)?.translateToString(false) ?? ''.padEnd(terminal.cols),
    );
    const actual = {
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      lines,
    };

    expect(actual).toEqual(golden.viewport);
    expect(actual.lines[manifest.renderedGolden.finalPromptRow].trimEnd()).toBe('› Ask Codex to do anything');
    terminal.dispose();
  });
});
