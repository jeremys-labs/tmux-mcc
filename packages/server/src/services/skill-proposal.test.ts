import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSkillSnapshot } from './skill-snapshot.js';
import { promotePendingSkill } from './skill-promotion.js';
import { proposePendingSkill } from './skill-proposal.js';

describe('skill-proposal', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-proposal-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes an agent pending skill without making it invocable', () => {
    const result = proposePendingSkill({
      agentKey: 'enzo',
      name: 'draft-review',
      description: 'Use for draft reviews.',
      body: 'Review drafts before they go live.',
      agentsRoot: tmpDir,
    });

    expect(result).toMatchObject({
      name: 'draft-review',
      scope: 'agent',
      snapshotSkillCount: 0,
    });
    const pendingPath = path.join(tmpDir, 'enzo', 'pending', 'skills', 'draft-review.md');
    expect(result.targetPath).toBe(pendingPath);
    expect(fs.readFileSync(pendingPath, 'utf8')).toContain('name: draft-review');

    const snapshot = buildSkillSnapshot({ agentKey: 'enzo', agentsRoot: tmpDir });
    expect(snapshot.skills.map((skill) => skill.name)).not.toContain('draft-review');
  });

  it('round-trips a proposed skill through promotion', () => {
    proposePendingSkill({
      agentKey: 'enzo',
      name: 'draft-review',
      description: 'Use for draft reviews.',
      body: 'Review drafts before they go live.',
      agentsRoot: tmpDir,
    });

    const promoted = promotePendingSkill({
      agentKey: 'enzo',
      name: 'draft-review',
      agentsRoot: tmpDir,
    });

    expect(promoted.afterSkillCount).toBe(1);
    const snapshot = buildSkillSnapshot({ agentKey: 'enzo', agentsRoot: tmpDir });
    expect(snapshot.skills.map((skill) => skill.name)).toContain('draft-review');
  });

  it('writes a shared pending skill without making it invocable', () => {
    proposePendingSkill({
      shared: true,
      name: 'team-skill',
      description: 'Use for shared team work.',
      body: 'Shared skill instructions.',
      agentsRoot: tmpDir,
    });

    expect(fs.existsSync(path.join(tmpDir, 'SHARED', 'pending', 'skills', 'team-skill.md'))).toBe(true);
    const snapshot = buildSkillSnapshot({ agentKey: 'enzo', agentsRoot: tmpDir });
    expect(snapshot.skills.map((skill) => skill.name)).not.toContain('team-skill');
  });

  it('refuses to overwrite an existing pending proposal', () => {
    proposePendingSkill({
      agentKey: 'enzo',
      name: 'draft-review',
      description: 'Use for draft reviews.',
      body: 'Review drafts before they go live.',
      agentsRoot: tmpDir,
    });

    expect(() => proposePendingSkill({
      agentKey: 'enzo',
      name: 'draft-review',
      description: 'Use for draft reviews.',
      body: 'Second proposal.',
      agentsRoot: tmpDir,
    })).toThrow(/Pending skill already exists/);
  });

  it('refuses to shadow an existing live skill', () => {
    const livePath = path.join(tmpDir, 'enzo', 'skills', 'draft-review', 'SKILL.md');
    fs.mkdirSync(path.dirname(livePath), { recursive: true });
    fs.writeFileSync(livePath, 'live');

    expect(() => proposePendingSkill({
      agentKey: 'enzo',
      name: 'draft-review',
      description: 'Use for draft reviews.',
      body: 'Review drafts before they go live.',
      agentsRoot: tmpDir,
    })).toThrow(/Live skill already exists/);
  });

  it('rejects unsafe names and frontmatter-bearing bodies', () => {
    expect(() => proposePendingSkill({
      agentKey: 'enzo',
      name: '../draft-review',
      description: 'Use for draft reviews.',
      body: 'Review drafts before they go live.',
      agentsRoot: tmpDir,
    })).toThrow(/Invalid skill name/);

    expect(() => proposePendingSkill({
      agentKey: 'enzo',
      name: 'draft-review',
      description: 'Use for draft reviews.',
      body: '---\nname: bad\n---\nBody.',
      agentsRoot: tmpDir,
    })).toThrow(/must not include frontmatter/);
  });
});
