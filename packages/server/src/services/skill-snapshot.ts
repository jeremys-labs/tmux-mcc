import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DEFAULT_AGENTS_ROOT = '/Volumes/Repo-Drive/agents';

export interface SkillEntry {
  name: string;
  description: string;
  scope: 'shared' | 'agent';
  location: string;
}

export interface SkillSnapshot {
  version: string;
  skills: SkillEntry[];
  prompt: string;
}

interface SkillSnapshotOptions {
  agentKey: string;
  agentsRoot?: string;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    result[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return result;
}

function discoverSkills(skillsDir: string, scope: 'shared' | 'agent'): SkillEntry[] {
  try {
    if (!fs.existsSync(skillsDir)) return [];
    return fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => {
        const skillMd = path.join(skillsDir, d.name, 'SKILL.md');
        if (!fs.existsSync(skillMd)) return [];
        const fm = parseFrontmatter(fs.readFileSync(skillMd, 'utf8'));
        return [{
          name: fm.name ?? d.name,
          description: fm.description ?? '',
          scope,
          location: skillMd,
        }];
      });
  } catch {
    return [];
  }
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
  if (!promptText.trim()) return [];
  const lower = promptText.toLowerCase();
  return skills
    .filter((s) => {
      const nameLower = s.name.toLowerCase().replace(/[-_]/g, ' ');
      const descLower = s.description.toLowerCase();
      if (lower.includes(nameLower)) return true;
      const words = nameLower.split(' ').filter((w) => w.length > 3);
      if (words.some((w) => lower.includes(w))) return true;
      const descWords = descLower.split(/\W+/).filter((w) => w.length > 5);
      if (descWords.some((w) => lower.includes(w))) return true;
      return false;
    })
    .map((s) => s.name);
}

export function isExplicitSkillRequest(promptText: string): boolean {
  if (!promptText.trim()) return false;
  const lower = promptText.toLowerCase();
  return lower.includes('/') || lower.includes('skill') || lower.includes('help me') || lower.includes('what skills');
}

export function buildSkillSnapshot(options: SkillSnapshotOptions): SkillSnapshot {
  const agentsRoot = options.agentsRoot ?? DEFAULT_AGENTS_ROOT;
  const sharedSkills = discoverSkills(path.join(agentsRoot, 'SHARED', 'skills'), 'shared');
  const agentSkills = discoverSkills(path.join(agentsRoot, options.agentKey, 'skills'), 'agent');
  const skills = [...agentSkills, ...sharedSkills];

  const version = crypto
    .createHash('sha1')
    .update(skills.map((s) => `${s.name}:${s.location}`).join('|'))
    .digest('hex')
    .slice(0, 12);

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
