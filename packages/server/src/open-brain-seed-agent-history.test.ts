import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { describe, expect, it } from 'vitest';
import { discoverAgents, toClaudeProjectKey } from './open-brain-seed-agent-history.js';

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

  it('discovers agents dynamically by presence of CLAUDE.md', () => {
    for (const name of ['zara', 'eli', 'hank']) {
      const agentDir = join(tmpRoot, name);
      mkdirSync(agentDir);
      writeFileSync(join(agentDir, 'CLAUDE.md'), `# ${name}`);
    }
    mkdirSync(join(tmpRoot, 'SHARED'));
    writeFileSync(join(tmpRoot, 'SHARED', 'TEAM.md'), '# team');

    expect(discoverAgents(tmpRoot)).toEqual(['eli', 'hank', 'zara']);
  });
});

describe('toClaudeProjectKey', () => {
  it('encodes a simple agent path (no dots)', () => {
    expect(toClaudeProjectKey('/Volumes/Repo-Drive/agents/eli')).toBe('-Volumes-Repo-Drive-agents-eli');
  });

  it('encodes a path containing dots (openclaw workspace)', () => {
    expect(toClaudeProjectKey('/Users/jeremylahners/.openclaw/workspace-eli')).toBe('-Users-jeremylahners--openclaw-workspace-eli');
  });

  it('produces the same key the hardcoded strings previously used', () => {
    // These were the two hardcoded values in oldAgentFiles() before this change.
    // Confirming the encoding function reproduces them given the same input paths.
    expect(toClaudeProjectKey('/Volumes/Repo-Drive/agents/eli')).toBe('-Volumes-Repo-Drive-agents-eli');
    expect(toClaudeProjectKey('/Users/jeremylahners/.openclaw/workspace-eli')).toBe('-Users-jeremylahners--openclaw-workspace-eli');
  });

  it('handles a home-relative openclaw root when OLD_OPENCLAW_ROOT is ~/.openclaw', () => {
    const homeBasedRoot = '/Users/someuser/.openclaw';
    const agent = 'marcus';
    expect(toClaudeProjectKey(`${homeBasedRoot}/workspace-${agent}`))
      .toBe('-Users-someuser--openclaw-workspace-marcus');
  });
});
