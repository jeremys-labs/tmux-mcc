#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { proposePendingSkill } from './services/skill-proposal.js';

type Args = {
  agent?: string;
  shared: boolean;
  name?: string;
  description?: string;
  body?: string;
  bodyFile?: string;
  bodyStdin: boolean;
  agentsRoot?: string;
};

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
    '  npm run skill:propose -- --agent <agent-key> --name <skill-name> --description <text> [--body <text> | --body-file <abs-path> | --body-stdin]',
    '  npm run skill:propose -- --shared --name <skill-name> --description <text> [--body <text> | --body-file <abs-path> | --body-stdin]',
  ].join('\n');
}

function parseArgs(): Args {
  return {
    agent: readArg('--agent'),
    shared: hasFlag('--shared'),
    name: readArg('--name'),
    description: readArg('--description'),
    body: readArg('--body'),
    bodyFile: readArg('--body-file'),
    bodyStdin: hasFlag('--body-stdin'),
    agentsRoot: readArg('--agents-root'),
  };
}

function readBody(args: Args): string {
  const sources = [args.body !== undefined, args.bodyFile !== undefined, args.bodyStdin].filter(Boolean).length;
  if (sources !== 1) {
    throw new Error(`Provide exactly one of --body, --body-file, or --body-stdin.\n${usage()}`);
  }
  if (args.body !== undefined) return args.body;
  if (args.bodyFile) {
    if (!path.isAbsolute(args.bodyFile)) {
      throw new Error(`--body-file must be an absolute path: ${args.bodyFile}`);
    }
    return fs.readFileSync(args.bodyFile, 'utf8');
  }
  return fs.readFileSync(0, 'utf8');
}

function main(): void {
  const args = parseArgs();
  if (!args.name) throw new Error(`Missing --name\n${usage()}`);
  if (!args.description) throw new Error(`Missing --description\n${usage()}`);

  const result = proposePendingSkill({
    name: args.name,
    description: args.description,
    body: readBody(args),
    agentKey: args.agent,
    shared: args.shared,
    agentsRoot: args.agentsRoot,
  });

  process.stdout.write([
    `proposed ${result.scope} skill ${result.name}`,
    `pending: ${result.targetPath}`,
    `snapshot: ${result.snapshotVersion} (${result.snapshotSkillCount} invocable skills; proposal remains inert)`,
  ].join('\n'));
  process.stdout.write('\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
