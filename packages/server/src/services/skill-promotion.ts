import fs from 'node:fs';
import path from 'node:path';
import { buildSkillSnapshot } from './skill-snapshot.js';

const DEFAULT_AGENTS_ROOT = '/Volumes/Repo-Drive/agents';

export interface PromotePendingSkillOptions {
  name: string;
  agentKey?: string;
  shared?: boolean;
  agentsRoot?: string;
}

export interface PromotePendingSkillResult {
  name: string;
  scope: 'agent' | 'shared';
  sourcePath: string;
  targetPath: string;
  beforeVersion: string;
  afterVersion: string;
  beforeSkillCount: number;
  afterSkillCount: number;
}

function assertSafeSkillName(name: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
    throw new Error(`Invalid skill name: ${name}`);
  }
}

function assertWithinDir(candidate: string, dir: string): void {
  const relative = path.relative(path.resolve(dir), path.resolve(candidate));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes skill root: ${candidate}`);
  }
}

function parseSkillFrontmatter(content: string): Record<string, string> {
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

function scopeRoot(agentsRoot: string, options: PromotePendingSkillOptions): { scope: 'agent' | 'shared'; root: string; snapshotAgentKey: string } {
  if (options.shared && options.agentKey) {
    throw new Error('Use either --shared or --agent, not both.');
  }
  if (options.shared) {
    return {
      scope: 'shared',
      root: path.join(agentsRoot, 'SHARED'),
      snapshotAgentKey: options.agentKey ?? 'eli',
    };
  }
  if (!options.agentKey) {
    throw new Error('Missing --agent for agent-scoped skill promotion.');
  }
  return {
    scope: 'agent',
    root: path.join(agentsRoot, options.agentKey),
    snapshotAgentKey: options.agentKey,
  };
}

export function promotePendingSkill(options: PromotePendingSkillOptions): PromotePendingSkillResult {
  assertSafeSkillName(options.name);
  const agentsRoot = options.agentsRoot ?? DEFAULT_AGENTS_ROOT;
  const { scope, root, snapshotAgentKey } = scopeRoot(agentsRoot, options);

  const sourcePath = path.join(root, 'pending', 'skills', `${options.name}.md`);
  const targetDir = path.join(root, 'skills', options.name);
  const targetPath = path.join(targetDir, 'SKILL.md');
  assertWithinDir(sourcePath, path.join(root, 'pending', 'skills'));
  assertWithinDir(targetPath, path.join(root, 'skills'));

  const sourceStat = fs.existsSync(sourcePath) ? fs.statSync(sourcePath) : null;
  if (!sourceStat?.isFile()) {
    throw new Error(`Pending skill file does not exist: ${sourcePath}`);
  }
  if (fs.existsSync(targetPath)) {
    throw new Error(`Live skill already exists: ${targetPath}`);
  }

  const content = fs.readFileSync(sourcePath, 'utf8');
  const frontmatter = parseSkillFrontmatter(content);
  if (frontmatter.name && frontmatter.name !== options.name) {
    throw new Error(`Pending skill frontmatter name "${frontmatter.name}" does not match file name "${options.name}".`);
  }

  const before = buildSkillSnapshot({
    agentKey: snapshotAgentKey,
    agentsRoot,
  });

  fs.mkdirSync(targetDir, { recursive: true });
  fs.renameSync(sourcePath, targetPath);

  const after = buildSkillSnapshot({
    agentKey: snapshotAgentKey,
    agentsRoot,
  });

  return {
    name: options.name,
    scope,
    sourcePath,
    targetPath,
    beforeVersion: before.version,
    afterVersion: after.version,
    beforeSkillCount: before.skills.length,
    afterSkillCount: after.skills.length,
  };
}
