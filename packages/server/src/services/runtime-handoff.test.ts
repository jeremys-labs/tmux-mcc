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

  it('switch-runtime delegates to the supervisor without prewriting the target runtime', () => {
    // Runtime switches were delegated to the agent-supervisor (commit "Delegate
    // runtime switches to supervisor"): switch-runtime.sh now POSTs a command to
    // the supervisor, which owns writing the handoff (.runtime-handoff.md) and
    // respawning the tmux pane. Those effects are covered by the supervisor's own
    // handoff/lifecycle tests; here we assert the script's remaining contract —
    // it delegates the correct command and never prewrites .runtime.
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(thisDir, '../../../..');
    const agentsRoot = path.join(tmpDir, 'agents');
    const agentDir = path.join(agentsRoot, 'eli');
    const fakeBin = path.join(tmpDir, 'bin');
    const requestLog = path.join(tmpDir, 'supervisor-request.log');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'launch.sh'), '#!/usr/bin/env bash\nexit 0\n');
    fs.writeFileSync(path.join(agentDir, '.runtime'), 'claude\n');
    // Fake curl: record the POSTed command body and URL, return a 200
    // command-result so the script reports success.
    fs.writeFileSync(path.join(fakeBin, 'curl'), [
      '#!/usr/bin/env bash',
      'output=""',
      'data=""',
      'url=""',
      'while [[ $# -gt 0 ]]; do',
      '  case "$1" in',
      '    --output) output="$2"; shift 2 ;;',
      '    --data) data="$2"; shift 2 ;;',
      '    http://*|https://*) url="$1"; shift ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      `printf '%s\\n%s\\n' "$url" "$data" >> ${JSON.stringify(requestLog)}`,
      'printf \'{"agent":"eli","runtime":"codex","status":"switch-prepared"}\' > "$output"',
      'printf 200',
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
    // The script must not prewrite the target runtime — the supervisor flips it
    // as part of the restart.
    expect(fs.readFileSync(path.join(agentDir, '.runtime'), 'utf8')).toBe('claude\n');
    // It delegated the correct switch-runtime command to the supervisor.
    const request = fs.readFileSync(requestLog, 'utf8');
    expect(request).toContain('/v1/commands');
    const body = JSON.parse(request.trim().split('\n').slice(1).join('\n')) as Record<string, unknown>;
    expect(body).toMatchObject({
      operation: 'switch-runtime',
      agent: 'eli',
      runtime: 'codex',
      reason: 'test switch',
      force: false,
    });
  });
});
