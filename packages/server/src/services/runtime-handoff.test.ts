import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildRuntimeHandoff,
  consumedRuntimeHandoffPath,
  loadPendingRuntimeHandoff,
  markRuntimeHandoffConsumed,
  runtimeHandoffPath,
  writeRuntimeHandoff,
} from './runtime-handoff.js';

describe('runtime handoff', () => {
  let tmpDir: string;
  let previousEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-handoff-'));
    previousEnv = { ...process.env };
    process.env.AGENT_MAIL_DIR = path.join(tmpDir, 'agent-mail');
    process.env.CONTENT_ROOT = path.join(tmpDir, 'content');
  });

  afterEach(() => {
    process.env = previousEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads no handoff on cold start without throwing', () => {
    expect(loadPendingRuntimeHandoff(tmpDir)).toBeNull();
  });

  it('ignores malformed handoff content without crashing or deleting it', () => {
    const filePath = runtimeHandoffPath(tmpDir);
    fs.writeFileSync(filePath, 'not json');

    expect(loadPendingRuntimeHandoff(tmpDir)).toBeNull();
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('keeps handoff pending until the wrapper marks injection consumed', () => {
    const handoff = buildRuntimeHandoff({
      agent: 'eli',
      fromRuntime: 'claude',
      toRuntime: 'codex',
      reason: 'test switch',
      workspace: tmpDir,
      now: new Date('2026-05-11T13:00:00.000Z'),
    });
    writeRuntimeHandoff(tmpDir, handoff);

    const pending = loadPendingRuntimeHandoff(tmpDir);
    expect(pending?.injectableText).toContain('schema_version: 1');
    expect(pending?.injectableText).toContain('runtime: claude -> codex');
    expect(fs.existsSync(runtimeHandoffPath(tmpDir))).toBe(true);

    markRuntimeHandoffConsumed(tmpDir, new Date('2026-05-11T13:01:00.000Z'));

    expect(fs.existsSync(runtimeHandoffPath(tmpDir))).toBe(false);
    expect(fs.readFileSync(consumedRuntimeHandoffPath(tmpDir), 'utf8')).toContain('consumed_at: 2026-05-11T13:01:00.000Z');
  });

  it('switch-runtime prepares handoff without prewriting the target runtime', () => {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(thisDir, '../../../..');
    const agentsRoot = path.join(tmpDir, 'agents');
    const agentDir = path.join(agentsRoot, 'eli');
    const fakeBin = path.join(tmpDir, 'bin');
    const tmuxLog = path.join(tmpDir, 'tmux.log');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'launch.sh'), '#!/usr/bin/env bash\nexit 0\n');
    fs.writeFileSync(path.join(agentDir, '.runtime'), 'claude\n');
    fs.writeFileSync(path.join(fakeBin, 'tmux'), [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$*" >> ${JSON.stringify(tmuxLog)}`,
      'case "$1" in',
      '  has-session|list-panes|set-option|send-keys|respawn-pane) exit 0 ;;',
      '  display-message) echo 1; exit 0 ;;',
      '  *) exit 0 ;;',
      'esac',
      '',
    ].join('\n'), { mode: 0o755 });

    const result = spawnSync('bash', [path.join(repoRoot, 'scripts/switch-runtime.sh'), 'eli', 'codex', 'test switch'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DETACHED: '1',
        AGENTS_DIR: agentsRoot,
        MCC_TMUX_ROOT: repoRoot,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.readFileSync(path.join(agentDir, '.runtime'), 'utf8')).toBe('claude\n');
    expect(loadPendingRuntimeHandoff(agentDir)?.handoff).toMatchObject({
      schema_version: 1,
      agent: 'eli',
      from_runtime: 'claude',
      to_runtime: 'codex',
      reason: 'test switch',
    });
    expect(fs.readFileSync(tmuxLog, 'utf8')).toContain('respawn-pane');
  });
});
