import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSkillSnapshot,
  buildSkillSnapshotForPrompt,
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
});
