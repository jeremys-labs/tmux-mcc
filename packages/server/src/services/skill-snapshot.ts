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
