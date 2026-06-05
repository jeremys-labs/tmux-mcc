import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverAgents } from './open-brain-seed-agent-history.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'history-seed-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('discoverAgents', () => {
  it('returns empty array when root does not exist', () => {
    expect(discoverAgents('/nonexistent/path/to/agents')).toEqual([]);
  });

  it('returns empty array when root exists but has no agent dirs with CLAUDE.md', () => {
    mkdirSync(join(tmpRoot, 'empty-dir'));
    expect(discoverAgents(tmpRoot)).toEqual([]);
  });

  it('discovers agents by presence of CLAUDE.md', () => {
    for (const name of ['eli', 'isla', 'marcus']) {
      const agentDir = join(tmpRoot, name);
      mkdirSync(agentDir);
      writeFileSync(join(agentDir, 'CLAUDE.md'), `# ${name}`);
    }
    mkdirSync(join(tmpRoot, 'not-an-agent'));
    expect(discoverAgents(tmpRoot)).toEqual(['eli', 'isla', 'marcus']);
  });

  it('returns agents sorted alphabetically', () => {
    for (const name of ['zara', 'eli', 'isla']) {
      const agentDir = join(tmpRoot, name);
      mkdirSync(agentDir);
      writeFileSync(join(agentDir, 'CLAUDE.md'), `# ${name}`);
    }
    expect(discoverAgents(tmpRoot)).toEqual(['eli', 'isla', 'zara']);
  });

  it('ignores directories without CLAUDE.md even if they have other files', () => {
    const agentDir = join(tmpRoot, 'marcus');
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# marcus');

    const nonAgentDir = join(tmpRoot, 'SHARED');
    mkdirSync(nonAgentDir);
    writeFileSync(join(nonAgentDir, 'TEAM.md'), '# team');

    expect(discoverAgents(tmpRoot)).toEqual(['marcus']);
  });
});

describe('claude project path encoding', () => {
  it('encodes agentsRoot + agent by replacing slashes with dashes', () => {
    const agentsRoot = '/Volumes/Repo-Drive/agents';
    const agent = 'eli';
    const encoded = join(agentsRoot, agent).replace(/\//g, '-');
    expect(encoded).toBe('-Volumes-Repo-Drive-agents-eli');
  });

  it('encodes HOME-relative agentsRoot correctly', () => {
    const homeDir = '/Users/testuser';
    const agentsRoot = join(homeDir, 'agents');
    const encoded = join(agentsRoot, 'nova').replace(/\//g, '-');
    expect(encoded).toBe('-Users-testuser-agents-nova');
  });
});
