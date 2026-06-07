import {
  matchingSkillNames as matchRegistrySkills,
  resolveSkillSnapshot,
  type SkillEntry,
} from '@agent-system/agent-skills';

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
  const { skills, version } = resolveSkillSnapshot({
    agentKey: options.agentKey,
    agentsRoot: options.agentsRoot ?? DEFAULT_AGENTS_ROOT,
  });

  return {
    version,
    skills,
    prompt: buildPrompt(options.agentKey, version, skills),
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
