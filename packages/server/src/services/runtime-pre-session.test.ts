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

import { buildPreSessionPrompt, writePreSessionPromptFile } from './runtime-pre-session.js';

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
