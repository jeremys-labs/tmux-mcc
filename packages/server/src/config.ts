import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import type { AppConfig } from './types/config.js';

export function resolveContentRoot(): string {
  const raw = process.env.CONTENT_ROOT || '~/.openclaw';
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
