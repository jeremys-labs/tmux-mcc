import {
  matchingSkillNames as matchRegistrySkills,
  resolveSkillSnapshot,
  type SkillEntry,
} from '@agent-system/agent-skills';
import crypto from 'node:crypto';
import path from 'node:path';

const DEFAULT_AGENTS_ROOT = '/Volumes/Repo-Drive/agents';

export type { SkillEntry } from '@agent-system/agent-skills';

export interface SkillSnapshot {
  version: string;
  skills: SkillEntry[];
  prompt: string;
}

interface SkillSnapshotOptions {
  agentKey: string;
  agentsRoot?: string;
}

function pendingSkillRoots(agentsRoot: string, agentKey: string): string[] {
  return [
    path.resolve(agentsRoot, agentKey, 'pending', 'skills'),
    path.resolve(agentsRoot, 'SHARED', 'pending', 'skills'),
  ];
}

function isWithinDir(candidate: string, dir: string): boolean {
  const relative = path.relative(dir, path.resolve(candidate));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function filterInvocableSkills(skills: SkillEntry[], options: SkillSnapshotOptions & { agentsRoot: string }): SkillEntry[] {
  const roots = pendingSkillRoots(options.agentsRoot, options.agentKey);
  return skills.filter((skill) => {
    const underPendingRoot = roots.some((root) => isWithinDir(skill.location, root));
    return !underPendingRoot;
  });
}

function skillSnapshotVersion(skills: SkillEntry[]): string {
  return crypto
    .createHash('sha1')
    .update(skills.map((skill) => `${skill.name}:${skill.location}`).join('|'))
    .digest('hex')
    .slice(0, 12);
}

function buildPrompt(agentKey: string, version: string, skills: SkillEntry[]): string {
  const instructions = 'Use the read tool to load a skill file when the task matches its name or description. Resolve relative paths from the skill directory.';
  const skillXml = skills.map((s) =>
    `    <skill>\n      <name>${s.name}</name>\n      <description>${s.description}</description>\n      <scope>${s.scope}</scope>\n      <location>${s.location}</location>\n    </skill>`
  ).join('\n');
  return `<available_skills>\n  <snapshot agent="${agentKey}" version="${version}">\n    <instructions>${instructions}</instructions>\n${skillXml}\n  </snapshot>\n</available_skills>`;
}

function buildCompactPrompt(agentKey: string, version: string, skills: SkillEntry[], matchingNames: string[]): string {
  const lines = [
    `skill_snapshot_version=${version}`,
    `skill_count=${skills.length}`,
  ];
  if (matchingNames.length > 0) {
    lines.push(`matching_skills=${matchingNames.join(', ')}`);
  }
  return `<available_skills>\n  <snapshot agent="${agentKey}" version="${version}">\n    <instructions>Use the Skill tool to invoke a skill when the task matches. Full list available on explicit skill/help requests.</instructions>\n    ${lines.join('\n    ')}\n  </snapshot>\n</available_skills>`;
}

export function matchingSkillNames(promptText: string, skills: SkillEntry[]): string[] {
  return matchRegistrySkills(promptText, skills);
}

export function isExplicitSkillRequest(promptText: string): boolean {
  if (!promptText.trim()) return false;
  const lower = promptText.toLowerCase();
  return lower.includes('/') || lower.includes('skill') || lower.includes('help me') || lower.includes('what skills');
}

export function buildSkillSnapshot(options: SkillSnapshotOptions): SkillSnapshot {
  const agentsRoot = options.agentsRoot ?? DEFAULT_AGENTS_ROOT;
  const { skills } = resolveSkillSnapshot({
    agentKey: options.agentKey,
    agentsRoot,
  });
  const invocableSkills = filterInvocableSkills(skills, {
    agentKey: options.agentKey,
    agentsRoot,
  });
  const version = skillSnapshotVersion(invocableSkills);

  return {
    version,
    skills: invocableSkills,
    prompt: buildPrompt(options.agentKey, version, invocableSkills),
  };
}

export function buildSkillSnapshotForPrompt(options: SkillSnapshotOptions & { promptText?: string }): SkillSnapshot & { compactPrompt: string } {
  const snapshot = buildSkillSnapshot(options);
  const promptText = options.promptText ?? '';
  const useFullXml = isExplicitSkillRequest(promptText);
  const matching = matchingSkillNames(promptText, snapshot.skills);
  const compactPrompt = useFullXml ? snapshot.prompt : buildCompactPrompt(options.agentKey, snapshot.version, snapshot.skills, matching);
  return { ...snapshot, compactPrompt };
}
