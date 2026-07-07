import fs from 'node:fs';
import path from 'node:path';
import { buildSkillSnapshot } from './skill-snapshot.js';

const DEFAULT_AGENTS_ROOT = '/Volumes/Repo-Drive/agents';

export interface ProposePendingSkillOptions {
  name: string;
  description: string;
  body: string;
  agentKey?: string;
  shared?: boolean;
  agentsRoot?: string;
}

export interface ProposePendingSkillResult {
  name: string;
  scope: 'agent' | 'shared';
  targetPath: string;
  snapshotVersion: string;
  snapshotSkillCount: number;
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

function normalizeDescription(description: string): string {
  const trimmed = description.trim();
  if (!trimmed) throw new Error('Missing skill description.');
  return trimmed.replace(/\r?\n/g, ' ');
}

function normalizeBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) throw new Error('Missing skill body.');
  if (/^---\r?\n/.test(trimmed)) {
    throw new Error('Skill body must not include frontmatter; pass name and description separately.');
  }
  return trimmed;
}

function scopeRoot(agentsRoot: string, options: ProposePendingSkillOptions): { scope: 'agent' | 'shared'; root: string; snapshotAgentKey: string } {
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
    throw new Error('Missing --agent for agent-scoped skill proposal.');
  }
  return {
    scope: 'agent',
    root: path.join(agentsRoot, options.agentKey),
    snapshotAgentKey: options.agentKey,
  };
}

function pendingSkillContent(name: string, description: string, body: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

export function proposePendingSkill(options: ProposePendingSkillOptions): ProposePendingSkillResult {
  assertSafeSkillName(options.name);
  const description = normalizeDescription(options.description);
  const body = normalizeBody(options.body);
  const agentsRoot = options.agentsRoot ?? DEFAULT_AGENTS_ROOT;
  const { scope, root, snapshotAgentKey } = scopeRoot(agentsRoot, options);

  const pendingRoot = path.join(root, 'pending', 'skills');
  const targetPath = path.join(pendingRoot, `${options.name}.md`);
  const livePath = path.join(root, 'skills', options.name, 'SKILL.md');
  assertWithinDir(targetPath, pendingRoot);
  assertWithinDir(livePath, path.join(root, 'skills'));

  if (fs.existsSync(targetPath)) {
    throw new Error(`Pending skill already exists: ${targetPath}`);
  }
  if (fs.existsSync(livePath)) {
    throw new Error(`Live skill already exists: ${livePath}`);
  }

  fs.mkdirSync(pendingRoot, { recursive: true });
  fs.writeFileSync(targetPath, pendingSkillContent(options.name, description, body), { flag: 'wx' });

  const snapshot = buildSkillSnapshot({
    agentKey: snapshotAgentKey,
    agentsRoot,
  });
  if (snapshot.skills.some((skill) => skill.name === options.name)) {
    throw new Error(`Proposed skill unexpectedly appeared in invocable snapshot: ${options.name}`);
  }

  return {
    name: options.name,
    scope,
    targetPath,
    snapshotVersion: snapshot.version,
    snapshotSkillCount: snapshot.skills.length,
  };
}
