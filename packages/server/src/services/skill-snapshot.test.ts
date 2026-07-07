import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSkillSnapshot,
  buildSkillSnapshotForPrompt,
  filterInvocableSkills,
  isExplicitSkillRequest,
  matchingSkillNames,
} from './skill-snapshot.js';

describe('skill-snapshot', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-snapshot-'));
    const sharedDir = path.join(tmpDir, 'SHARED', 'skills', 'runtime-canary');
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.writeFileSync(path.join(sharedDir, 'SKILL.md'), [
      '---',
      'name: runtime-canary',
      'description: Use only when asked to report the runtime canary phrase.',
      '---',
      'Reply: central skills are live.',
    ].join('\n'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects explicit skill requests', () => {
    expect(isExplicitSkillRequest('Use the /runtime-canary skill')).toBe(true);
    expect(isExplicitSkillRequest('Use the skill')).toBe(true);
    expect(isExplicitSkillRequest('help me debug this')).toBe(true);
    expect(isExplicitSkillRequest('What is the status of the deploy?')).toBe(false);
    expect(isExplicitSkillRequest('Run the tests')).toBe(false);
  });

  it('matches skills by name keywords in prompt', () => {
    const snapshot = buildSkillSnapshot({ agentKey: 'enzo', agentsRoot: tmpDir });
    expect(matchingSkillNames('report the canary phrase', snapshot.skills)).toContain('runtime-canary');
    expect(matchingSkillNames('check the runtime status', snapshot.skills)).toContain('runtime-canary');
    expect(matchingSkillNames('ship a PR', snapshot.skills)).toEqual([]);
  });

  it('returns full XML for explicit skill requests', () => {
    const result = buildSkillSnapshotForPrompt({
      agentKey: 'enzo',
      agentsRoot: tmpDir,
      promptText: 'Use the skill to report the canary',
    });
    expect(result.compactPrompt).toContain('<skill>');
    expect(result.compactPrompt).toContain('Use only when asked to report');
    expect(result.compactPrompt).toContain('<location>');
  });

  it('returns compact format for routine prompts without skill triggers', () => {
    const result = buildSkillSnapshotForPrompt({
      agentKey: 'enzo',
      agentsRoot: tmpDir,
      promptText: 'What is the deploy status?',
    });
    expect(result.compactPrompt).not.toContain('<location>');
    expect(result.compactPrompt).not.toContain('<description>Use only when');
    expect(result.compactPrompt).toContain('<available_skills>');
  });

  it('includes matching skill names in compact prompt when prompt triggers a skill', () => {
    const result = buildSkillSnapshotForPrompt({
      agentKey: 'enzo',
      agentsRoot: tmpDir,
      promptText: 'report the canary phrase',
    });
    expect(result.compactPrompt).toContain('runtime-canary');
    expect(result.compactPrompt).not.toContain('<location>');
  });

  it('keeps pending skill files out of the invocable snapshot until promoted', () => {
    const liveDir = path.join(tmpDir, 'enzo', 'skills', 'live-review');
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(path.join(liveDir, 'SKILL.md'), [
      '---',
      'name: live-review',
      'description: Use for reviewed live work.',
      '---',
      'Live skill.',
    ].join('\n'));

    const pendingDir = path.join(tmpDir, 'enzo', 'pending', 'skills');
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, 'draft-review.md'), [
      '---',
      'name: draft-review',
      'description: Pending review only.',
      '---',
      'Draft skill.',
    ].join('\n'));

    const before = buildSkillSnapshot({ agentKey: 'enzo', agentsRoot: tmpDir });
    expect(before.skills.map((skill) => skill.name)).toContain('live-review');
    expect(before.skills.map((skill) => skill.name)).not.toContain('draft-review');
    expect(before.prompt).not.toContain('draft-review');

    const promotedDir = path.join(tmpDir, 'enzo', 'skills', 'draft-review');
    fs.mkdirSync(promotedDir, { recursive: true });
    fs.renameSync(path.join(pendingDir, 'draft-review.md'), path.join(promotedDir, 'SKILL.md'));

    const after = buildSkillSnapshot({ agentKey: 'enzo', agentsRoot: tmpDir });
    expect(after.skills.map((skill) => skill.name)).toContain('draft-review');
    expect(after.prompt).toContain('draft-review');
  });

  it('does not throw when pending skill directories are missing or malformed', () => {
    expect(() => buildSkillSnapshot({ agentKey: 'enzo', agentsRoot: tmpDir })).not.toThrow();

    const malformedPending = path.join(tmpDir, 'enzo', 'pending', 'skills');
    fs.mkdirSync(path.dirname(malformedPending), { recursive: true });
    fs.writeFileSync(malformedPending, 'not a directory');

    const result = buildSkillSnapshot({ agentKey: 'enzo', agentsRoot: tmpDir });
    expect(result.skills.map((skill) => skill.name)).toContain('runtime-canary');
  });

  it('filters any pending skill locations if a registry starts returning them', () => {
    const pendingLocation = path.join(tmpDir, 'enzo', 'pending', 'skills', 'draft-review.md');
    fs.mkdirSync(path.dirname(pendingLocation), { recursive: true });
    fs.writeFileSync(pendingLocation, 'draft');

    const filtered = filterInvocableSkills([
      {
        name: 'draft-review',
        description: 'Pending review only.',
        scope: 'agent',
        location: pendingLocation,
      },
      {
        name: 'live-review',
        description: 'Reviewed live work.',
        scope: 'agent',
        location: path.join(tmpDir, 'enzo', 'skills', 'live-review', 'SKILL.md'),
      },
    ], {
      agentKey: 'enzo',
      agentsRoot: tmpDir,
    });

    expect(filtered.map((skill) => skill.name)).toEqual(['live-review']);
  });
});
