import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import type { AppConfig } from './types/config.js';

// Load .env from project root (two levels up from packages/server)
function loadDotEnv(): void {
  const envPath = path.join(import.meta.dirname, '../../..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadDotEnv();

export function resolveContentRoot(): string {
  const raw = process.env.CONTENT_ROOT || '~/.tmux-mcc';
  return raw.startsWith('~') ? raw.replace('~', process.env.HOME || '') : raw;
}

export function resolveDocsDir(contentRoot: string): string {
  const raw = process.env.DOCS_DIR || path.join(contentRoot, 'docs');
  return raw.startsWith('~') ? raw.replace('~', process.env.HOME || '') : raw;
}

export function loadConfig(contentRoot?: string): AppConfig {
  const root = contentRoot || resolveContentRoot();
  const configPath = path.join(root, 'config.yaml');

  if (!fs.existsSync(configPath)) {
    throw new Error(`config.yaml not found at ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = parseYaml(raw) as AppConfig;

  if (!config.agents || Object.keys(config.agents).length === 0) {
    throw new Error('config.yaml must define at least one agent in the agents section');
  }

  return config;
}
