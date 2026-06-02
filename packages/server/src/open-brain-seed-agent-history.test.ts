import { describe, expect, it } from 'vitest';
import { toClaudeProjectKey } from './open-brain-seed-agent-history.js';

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
