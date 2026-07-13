import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkUpdateGuard, injectUpdateGuard, ensureCodexUpdateGuard } from './codex-update-guard.js';

// REGRESSION FIXTURE — cecelia's real 2026-07-08 config shape. Root keys had
// drifted below the [projects] table headers, so codex read them as table
// members and reported "Model metadata for cecelia not found". Any key this
// guard writes (or trusts) below a table header repeats that incident.
const CECELIA_7_08_SHAPE = `model = "cecelia"
model_provider = "ollama"

[projects."/Volumes/Repo-Drive/agents/cecelia"]
trust_level = "trusted"

[model_providers.ollama]
name = "Ollama"
base_url = "http://127.0.0.1:11434/v1"
`;

describe('checkUpdateGuard — root-scope-aware detection', () => {
  it('reports missing when the key is absent', () => {
    expect(checkUpdateGuard(CECELIA_7_08_SHAPE)).toBe('missing');
  });

  it('reports ok when the key is false at root scope', () => {
    expect(checkUpdateGuard(`check_for_update_on_startup = false\n${CECELIA_7_08_SHAPE}`)).toBe('ok');
  });

  it('reports explicitly-enabled when the key is true at root scope', () => {
    expect(checkUpdateGuard(`check_for_update_on_startup = true\n${CECELIA_7_08_SHAPE}`)).toBe('explicitly-enabled');
  });

  it('does NOT trust the key when it sits below a table header (the 7/8 scoping bug)', () => {
    const misScoped = `${CECELIA_7_08_SHAPE}check_for_update_on_startup = false\n`;
    expect(checkUpdateGuard(misScoped)).toBe('missing');
  });
});

describe('injectUpdateGuard — never scopes the key into a table', () => {
  it('inserts before the first table header, keeping the key at root scope', () => {
    const patched = injectUpdateGuard(CECELIA_7_08_SHAPE);
    expect(checkUpdateGuard(patched)).toBe('ok');
    const lines = patched.split('\n');
    const keyIndex = lines.findIndex((l) => l.startsWith('check_for_update_on_startup'));
    const tableIndex = lines.findIndex((l) => l.startsWith('['));
    expect(keyIndex).toBeGreaterThan(-1);
    expect(keyIndex).toBeLessThan(tableIndex);
  });

  it('preserves every original line', () => {
    const patched = injectUpdateGuard(CECELIA_7_08_SHAPE);
    for (const line of CECELIA_7_08_SHAPE.split('\n')) {
      expect(patched).toContain(line);
    }
  });

  it('appends when the config has no tables', () => {
    const patched = injectUpdateGuard('model = "cecelia"\n');
    expect(checkUpdateGuard(patched)).toBe('ok');
  });
});

describe('ensureCodexUpdateGuard — filesystem shell', () => {
  let tmpDir: string | null = null;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function makeCodexHome(configText?: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-guard-'));
    if (configText !== undefined) {
      fs.writeFileSync(path.join(tmpDir, 'config.toml'), configText);
    }
    return tmpDir;
  }

  it('patches a missing key on disk and is idempotent', () => {
    const home = makeCodexHome(CECELIA_7_08_SHAPE);
    expect(ensureCodexUpdateGuard(home)).toEqual({ status: 'missing', patched: true });
    expect(ensureCodexUpdateGuard(home)).toEqual({ status: 'ok', patched: false });
  });

  it('leaves an explicitly-enabled config untouched', () => {
    const text = `check_for_update_on_startup = true\n${CECELIA_7_08_SHAPE}`;
    const home = makeCodexHome(text);
    expect(ensureCodexUpdateGuard(home)).toEqual({ status: 'explicitly-enabled', patched: false });
    expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toBe(text);
  });

  it('reports no-config without creating a file', () => {
    const home = makeCodexHome();
    expect(ensureCodexUpdateGuard(home)).toEqual({ status: 'no-config', patched: false });
    expect(fs.existsSync(path.join(home, 'config.toml'))).toBe(false);
  });
});
