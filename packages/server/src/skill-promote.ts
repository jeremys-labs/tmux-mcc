#!/usr/bin/env node
import { promotePendingSkill } from './services/skill-promotion.js';

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): string {
  return [
    'Usage:',
    '  npm run skill:promote -- --agent <agent-key> --name <skill-name> [--agents-root <path>]',
    '  npm run skill:promote -- --shared --name <skill-name> [--agents-root <path>]',
  ].join('\n');
}

function main(): void {
  const name = readArg('--name');
  if (!name) throw new Error(`Missing --name\n${usage()}`);

  const result = promotePendingSkill({
    name,
    agentKey: readArg('--agent'),
    shared: hasFlag('--shared'),
    agentsRoot: readArg('--agents-root'),
  });

  process.stdout.write([
    `promoted ${result.scope} skill ${result.name}`,
    `source: ${result.sourcePath}`,
    `target: ${result.targetPath}`,
    `snapshot: ${result.beforeVersion} (${result.beforeSkillCount}) -> ${result.afterVersion} (${result.afterSkillCount})`,
  ].join('\n'));
  process.stdout.write('\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
