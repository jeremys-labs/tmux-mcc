import fs from 'fs';
import path from 'path';

const REQUIRED_DIRS = [
  'data',
  'data/token-usage',
  'files/inbox',
  'files/approved',
  'files/archive',
  'databases',
  'memory/agents',
  'assets',
];

export function ensureContentDirs(contentRoot: string): void {
  for (const dir of REQUIRED_DIRS) {
    fs.mkdirSync(path.join(contentRoot, dir), { recursive: true });
  }
}

export function getContentPath(contentRoot: string, ...segments: string[]): string {
  return path.join(contentRoot, ...segments);
}
