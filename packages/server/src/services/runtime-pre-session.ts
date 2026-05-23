import fs from 'fs';
import path from 'path';
import {
  formatStartupMemoryForClaude,
  formatStartupMemoryForCodex,
  searchStartupMemory,
  type OpenBrainRuntimeConfig,
} from './open-brain-runtime.js';

const DEFAULT_AGENTS_ROOT = '/Volumes/Repo-Drive/agents';

export interface BuildPreSessionPromptInput {
  agentKey: string;
  runtime: 'claude' | 'codex';
  agentsRoot?: string;
  openBrainConfig?: OpenBrainRuntimeConfig | null;
  /** Test seam — bypass the OB1 network call. */
  fetchStartupMemory?: (config: OpenBrainRuntimeConfig) => Promise<string>;
}

export interface PreSessionPrompt {
  /** Combined system-prompt text. Empty string when no content was assembled. */
  text: string;
  /** Whether SOUL.md was found and included. */
  hasSoul: boolean;
  /** Whether OB1 startup memory was included. */
  hasMemory: boolean;
}

function readSoul(agentKey: string, agentsRoot: string): string {
  const soulPath = path.join(agentsRoot, agentKey, 'SOUL.md');
  try {
    return fs.readFileSync(soulPath, 'utf8').trim();
  } catch {
    return '';
  }
}

export async function buildPreSessionPrompt(
  input: BuildPreSessionPromptInput,
): Promise<PreSessionPrompt> {
  const agentsRoot = input.agentsRoot ?? DEFAULT_AGENTS_ROOT;
  const soul = readSoul(input.agentKey, agentsRoot);

  let memoryBlock = '';
  if (input.openBrainConfig) {
    try {
      const raw = input.fetchStartupMemory
        ? await input.fetchStartupMemory(input.openBrainConfig)
        : await searchStartupMemory(input.openBrainConfig);
      memoryBlock = input.runtime === 'codex'
        ? formatStartupMemoryForCodex(input.agentKey, raw)
        : formatStartupMemoryForClaude(input.agentKey, raw);
    } catch {
      memoryBlock = '';
    }
  }

  const sections: string[] = [];
  if (soul) {
    sections.push(soul);
  }
  if (memoryBlock) {
    sections.push(memoryBlock);
  }

  return {
    text: sections.join('\n\n'),
    hasSoul: Boolean(soul),
    hasMemory: Boolean(memoryBlock),
  };
}

export interface WritePreSessionPromptInput {
  agentKey: string;
  contentRoot: string;
  text: string;
}

/**
 * Persists the pre-session prompt to a stable path under the runtime-state dir
 * so the underlying CLI can read it via `--append-system-prompt-file` and so
 * external observers (runtime-health, MCC UI) can inspect what was injected.
 */
export function writePreSessionPromptFile(input: WritePreSessionPromptInput): string {
  const dir = path.join(input.contentRoot, 'bridge', 'runtime-state');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${input.agentKey}-pre-session.txt`);
  fs.writeFileSync(file, input.text, 'utf8');
  return file;
}
