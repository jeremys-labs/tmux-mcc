import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./open-brain-runtime.js', async () => {
  const actual = await vi.importActual<typeof import('./open-brain-runtime.js')>('./open-brain-runtime.js');
  return {
    ...actual,
    searchStartupMemory: vi.fn(async () => 'mock-memory'),
  };
});

import { buildPreSessionPrompt, writePreSessionContextSidecar, writePreSessionPromptFile } from './runtime-pre-session.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-session-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeSoul(agentKey: string, body: string): string {
  const agentDir = path.join(tmp, agentKey);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'SOUL.md'), body);
  return tmp;
}

describe('buildPreSessionPrompt', () => {
  it('returns empty when there is no SOUL.md and no openBrainConfig', async () => {
    const result = await buildPreSessionPrompt({
      agentKey: 'enzo',
      runtime: 'claude',
      agentsRoot: tmp,
      openBrainConfig: null,
    });
    expect(result.text).toBe('');
    expect(result.hasSoul).toBe(false);
    expect(result.hasMemory).toBe(false);
  });

  it('includes SOUL.md when present', async () => {
    writeSoul('enzo', '# Enzo SOUL\n\nbody');
    const result = await buildPreSessionPrompt({
      agentKey: 'enzo',
      runtime: 'claude',
      agentsRoot: tmp,
      openBrainConfig: null,
    });
    expect(result.hasSoul).toBe(true);
    expect(result.text).toContain('# Enzo SOUL');
  });

  it('appends OB1 startup memory when openBrainConfig is supplied (Claude format)', async () => {
    writeSoul('enzo', 'SOUL-CONTENT');
    const result = await buildPreSessionPrompt({
      agentKey: 'enzo',
      runtime: 'claude',
      agentsRoot: tmp,
      openBrainConfig: { agentId: 'enzo' } as never,
      fetchStartupMemory: async () => 'memory-payload',
    });
    expect(result.hasSoul).toBe(true);
    expect(result.hasMemory).toBe(true);
    expect(result.text).toContain('SOUL-CONTENT');
    expect(result.text).toContain('[Open Brain Startup Recall]');
    expect(result.text).toContain('memory-payload');
  });

  it('formats memory block for Codex when runtime is codex', async () => {
    const result = await buildPreSessionPrompt({
      agentKey: 'enzo',
      runtime: 'codex',
      agentsRoot: tmp,
      openBrainConfig: { agentId: 'enzo' } as never,
      fetchStartupMemory: async () => 'memory-payload',
    });
    expect(result.text).toContain('[Open Brain Startup Recall]');
    expect(result.text).toContain('memory-payload');
  });

  it('continues without memory when fetchStartupMemory throws', async () => {
    writeSoul('enzo', 'SOUL-CONTENT');
    const result = await buildPreSessionPrompt({
      agentKey: 'enzo',
      runtime: 'claude',
      agentsRoot: tmp,
      openBrainConfig: { agentId: 'enzo' } as never,
      fetchStartupMemory: async () => {
        throw new Error('boom');
      },
    });
    expect(result.hasSoul).toBe(true);
    expect(result.hasMemory).toBe(false);
    expect(result.text).toContain('SOUL-CONTENT');
  });
});

describe('readInFlightSection / In-Flight injection', () => {
  function writeIndex(agentKey: string, body: string): void {
    const dir = path.join(tmp, agentKey, 'memory', 'agents', agentKey);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.md'), body);
  }

  it('injects In-Flight block when the section has bullet entries', async () => {
    writeIndex('marcus', [
      '# Marcus Index',
      '',
      '## In Flight',
      '',
      'Tasks started but not yet shipped or explicitly blocked. Clear each entry when done.',
      '',
      '- Reviewing `eli/loop5-scheduler-run-result-log` (f743f37) — started 10:10 AM, verdict owed to Eli',
      '',
      '---',
      '',
      '## Other Section',
    ].join('\n'));

    const result = await buildPreSessionPrompt({
      agentKey: 'marcus',
      runtime: 'claude',
      agentsRoot: tmp,
      openBrainConfig: null,
    });

    expect(result.hasInFlight).toBe(true);
    expect(result.text).toContain('[In-Flight Work]');
    expect(result.text).toContain('eli/loop5-scheduler-run-result-log');
  });

  it('does not inject when In-Flight section contains only the empty placeholder', async () => {
    writeIndex('marcus', [
      '# Marcus Index',
      '',
      '## In Flight',
      '',
      'Tasks started but not yet shipped or explicitly blocked. Clear each entry when done.',
      '',
      '_(none)_',
      '',
      '---',
    ].join('\n'));

    const result = await buildPreSessionPrompt({
      agentKey: 'marcus',
      runtime: 'claude',
      agentsRoot: tmp,
      openBrainConfig: null,
    });

    expect(result.hasInFlight).toBe(false);
    expect(result.text).not.toContain('[In-Flight Work]');
  });

  it('does not inject and does not throw when no index file exists', async () => {
    const result = await buildPreSessionPrompt({
      agentKey: 'marcus',
      runtime: 'claude',
      agentsRoot: tmp,
      openBrainConfig: null,
    });

    expect(result.hasInFlight).toBe(false);
    expect(result.text).toBe('');
  });

  it('appends In-Flight block after soul and memory sections', async () => {
    writeSoul('marcus', 'SOUL-CONTENT');
    writeIndex('marcus', [
      '## In Flight',
      '',
      '- Active task A',
      '',
      '---',
    ].join('\n'));

    const result = await buildPreSessionPrompt({
      agentKey: 'marcus',
      runtime: 'claude',
      agentsRoot: tmp,
      openBrainConfig: null,
    });

    expect(result.hasSoul).toBe(true);
    expect(result.hasInFlight).toBe(true);
    const soulPos = result.text.indexOf('SOUL-CONTENT');
    const inflightPos = result.text.indexOf('[In-Flight Work]');
    expect(soulPos).toBeLessThan(inflightPos);
  });
});

describe('writePreSessionContextSidecar', () => {
  it('writes the JSON sidecar without creating a .txt file', () => {
    writePreSessionContextSidecar({
      agentKey: 'enzo',
      contentRoot: tmp,
      hasSoul: true,
      hasMemory: false,
      runtime: 'codex',
    });
    const sidecarPath = path.join(tmp, 'bridge', 'runtime-state', 'enzo-pre-session-context.json');
    const txtPath = path.join(tmp, 'bridge', 'runtime-state', 'enzo-pre-session.txt');
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(fs.existsSync(txtPath)).toBe(false);
    const record = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    expect(record.hasSoul).toBe(true);
    expect(record.hasMemory).toBe(false);
    expect(record.runtime).toBe('codex');
    expect(typeof record.generatedAt).toBe('string');
  });

  it('creates parent directories if missing', () => {
    const nested = path.join(tmp, 'deep', 'root');
    writePreSessionContextSidecar({ agentKey: 'enzo', contentRoot: nested, hasSoul: false, hasMemory: true, runtime: 'codex' });
    expect(fs.existsSync(path.join(nested, 'bridge', 'runtime-state', 'enzo-pre-session-context.json'))).toBe(true);
  });
});

describe('writePreSessionPromptFile', () => {
  it('writes to <contentRoot>/bridge/runtime-state/<agent>-pre-session.txt', () => {
    const file = writePreSessionPromptFile({
      agentKey: 'enzo',
      contentRoot: tmp,
      text: 'hello',
    });
    expect(file.endsWith('/bridge/runtime-state/enzo-pre-session.txt')).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('hello');
  });

  it('creates parent directories if missing', () => {
    const nested = path.join(tmp, 'deep', 'root');
    const file = writePreSessionPromptFile({ agentKey: 'enzo', contentRoot: nested, text: 'x' });
    expect(fs.existsSync(file)).toBe(true);
  });
});
