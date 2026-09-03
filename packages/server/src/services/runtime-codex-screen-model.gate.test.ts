import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { createRuntimeTerminalScreen } from './runtime-terminal-screen.js';

const require = createRequire(import.meta.url);

const fixtureUrl = new URL('./__fixtures__/codex-readiness-v0.151.0-final-prompt.json', import.meta.url);
const goldenUrl = new URL('./__fixtures__/codex-readiness-v0.151.0-xterm-6.0.0-golden.json', import.meta.url);
const manifestUrl = new URL('./__fixtures__/codex-readiness-evidence-manifest.json', import.meta.url);
const tmuxOracleUrl = new URL('./__fixtures__/codex-readiness-v0.151.0-tmux-oracle.json', import.meta.url);

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

describe('@xterm/headless Friday acceptance gate', () => {
  it('fails loudly if the pinned CommonJS resolution workaround changes shape', () => {
    const packageJson = require('@xterm/headless/package.json') as { version: string; main: string; module: string };
    const runtimeModule = require('@xterm/headless') as Record<string, unknown>;

    expect(packageJson).toMatchObject({
      version: '6.0.0',
      main: 'lib-headless/xterm-headless.js',
      module: 'lib/xterm.mjs',
    });
    expect(require.resolve('@xterm/headless')).toMatch(/lib-headless\/xterm-headless\.js$/);
    expect(Object.keys(runtimeModule).sort()).toEqual(['Terminal']);
    expect(typeof runtimeModule.Terminal).toBe('function');
  });

  it('imports in the server and deterministically reconstructs the pinned final viewport', async () => {
    const fixtureBytes = fs.readFileSync(fixtureUrl);
    const goldenBytes = fs.readFileSync(goldenUrl);
    const fixture = JSON.parse(fixtureBytes.toString('utf8'));
    const golden = JSON.parse(goldenBytes.toString('utf8'));
    const manifest = JSON.parse(fs.readFileSync(manifestUrl, 'utf8'));
    const tmuxOracleBytes = fs.readFileSync(tmuxOracleUrl);
    const tmuxOracle = JSON.parse(tmuxOracleBytes.toString('utf8'));

    expect(sha256(fixtureBytes)).toBe(manifest.streamFixture.fileSha256);
    expect(sha256(goldenBytes)).toBe(manifest.renderedGolden.fileSha256);
    expect(sha256(tmuxOracleBytes)).toBe(manifest.independentTmuxOracle.fileSha256);
    expect(fixture.chunks).toHaveLength(manifest.streamFixture.callbackCount);

    const terminal = createRuntimeTerminalScreen(golden.renderer.options);
    let actual: Awaited<ReturnType<typeof terminal.write>> | undefined;
    for (const chunk of fixture.chunks) {
      actual = await terminal.write(Buffer.from(chunk.dataBase64, 'base64'));
    }

    expect(actual).toMatchObject(golden.viewport);
    expect(actual!.lines[manifest.renderedGolden.finalPromptRow].trimEnd()).toBe('› Ask Codex to do anything');
    expect(actual!.lines.map((line) => line.trimEnd())).toEqual(
      tmuxOracle.screen.lines.map((line: string) => line.trimEnd()),
    );
    terminal.dispose();
  });

  it('keeps the n=1 fixture replay subordinate to review and controlled live acceptance', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestUrl, 'utf8'));
    expect(manifest.deploymentCriteria).toMatchObject({
      preservedCaptureCount: 1,
      fixtureReplayAloneIsSufficient: false,
      independentReviewRequired: true,
      controlledLiveTurnRequired: true,
    });
  });
});
