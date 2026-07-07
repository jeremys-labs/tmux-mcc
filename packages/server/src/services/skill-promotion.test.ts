import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSkillSnapshot } from './skill-snapshot.js';
import { promotePendingSkill } from './skill-promotion.js';

describe('skill-promotion', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-promotion-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePending(agentKey: string, name: string, frontmatterName = name): string {
    const pendingPath = path.join(tmpDir, agentKey, 'pending', 'skills', `${name}.md`);
    fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
    fs.writeFileSync(pendingPath, [
      '---',
      `name: ${frontmatterName}`,
      'description: Pending skill for tests.',
      '---',
      'Pending body.',
    ].join('\n'));
    return pendingPath;
  }

  it('promotes an agent pending skill into the live SKILL.md layout', () => {
    writePending('enzo', 'draft-review');

    const before = buildSkillSnapshot({ agentKey: 'enzo', agentsRoot: tmpDir });
    expect(before.skills.map((skill) => skill.name)).not.toContain('draft-review');

    const result = promotePendingSkill({
      agentKey: 'enzo',
      name: 'draft-review',
      agentsRoot: tmpDir,
    });

    expect(result).toMatchObject({
      name: 'draft-review',
      scope: 'agent',
      beforeSkillCount: 0,
      afterSkillCount: 1,
    });
    expect(fs.existsSync(path.join(tmpDir, 'enzo', 'pending', 'skills', 'draft-review.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'enzo', 'skills', 'draft-review', 'SKILL.md'))).toBe(true);

    const after = buildSkillSnapshot({ agentKey: 'enzo', agentsRoot: tmpDir });
    expect(after.skills.map((skill) => skill.name)).toContain('draft-review');
  });

  it('promotes a shared pending skill into the shared live layout', () => {
    const pendingPath = path.join(tmpDir, 'SHARED', 'pending', 'skills', 'team-skill.md');
    fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
    fs.writeFileSync(pendingPath, [
      '---',
      'name: team-skill',
      'description: Shared pending skill.',
      '---',
      'Shared pending body.',
    ].join('\n'));

    const result = promotePendingSkill({
      shared: true,
      name: 'team-skill',
      agentsRoot: tmpDir,
    });

    expect(result.scope).toBe('shared');
    expect(fs.existsSync(path.join(tmpDir, 'SHARED', 'skills', 'team-skill', 'SKILL.md'))).toBe(true);
    const after = buildSkillSnapshot({ agentKey: 'enzo', agentsRoot: tmpDir });
    expect(after.skills.map((skill) => skill.name)).toContain('team-skill');
  });

  it('refuses to overwrite an existing live skill', () => {
    writePending('enzo', 'draft-review');
    const livePath = path.join(tmpDir, 'enzo', 'skills', 'draft-review', 'SKILL.md');
    fs.mkdirSync(path.dirname(livePath), { recursive: true });
    fs.writeFileSync(livePath, 'live');

    expect(() => promotePendingSkill({
      agentKey: 'enzo',
      name: 'draft-review',
      agentsRoot: tmpDir,
    })).toThrow(/already exists/);
  });

  it('rejects frontmatter names that do not match the pending file name', () => {
    writePending('enzo', 'draft-review', 'other-name');

    expect(() => promotePendingSkill({
      agentKey: 'enzo',
      name: 'draft-review',
      agentsRoot: tmpDir,
    })).toThrow(/does not match/);
  });

  it('rejects unsafe skill names before building paths', () => {
    expect(() => promotePendingSkill({
      agentKey: 'enzo',
      name: '../draft-review',
      agentsRoot: tmpDir,
    })).toThrow(/Invalid skill name/);
  });
});
