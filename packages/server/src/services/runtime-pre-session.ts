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
  /** Whether an In-Flight section from the agent index was included. */
  hasInFlight: boolean;
}

function readSoul(agentKey: string, agentsRoot: string): string {
  const soulPath = path.join(agentsRoot, agentKey, 'SOUL.md');
  try {
    return fs.readFileSync(soulPath, 'utf8').trim();
  } catch {
    return '';
  }
}

// Reads the "## In Flight" section from the agent's memory index and returns a
// formatted block for pre-session injection. Returns empty string when the
// section is absent, unreadable, or contains no bullet entries (i.e. only the
// empty placeholder written by the Loop 4 rule).
// Index convention: {agentsRoot}/{agentKey}/memory/agents/{agentKey}/index.md
// Regression anchor: 2026-06-28 — Eli review (msg_6e3cgtdc) dropped for 10 h
// because no startup signal existed; Loop 4 shipped the write discipline, this
// makes the recovery structural.
function readInFlightSection(agentKey: string, agentsRoot: string): string {
  const indexPath = path.join(
    agentsRoot, agentKey, 'memory', 'agents', agentKey, 'index.md',
  );
  let content: string;
  try {
    content = fs.readFileSync(indexPath, 'utf8');
  } catch {
    return '';
  }

  // Extract the ## In Flight section up to the next --- separator or ## heading.
  const match = content.match(/^## In Flight\n([\s\S]*?)(?=\n---|\n## )/m);
  if (!match) return '';

  // Only inject when there are actual bullet entries; skip the empty placeholder.
  if (!/^- /m.test(match[1])) return '';

  return `[In-Flight Work] Active tasks from your agent index:\n\n## In Flight\n${match[1].trimEnd()}`;
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

  const inFlightBlock = readInFlightSection(input.agentKey, agentsRoot);

  const sections: string[] = [];
  if (soul) {
    sections.push(soul);
  }
  if (memoryBlock) {
    sections.push(memoryBlock);
  }
  if (inFlightBlock) {
    sections.push(inFlightBlock);
  }

  return {
    text: sections.join('\n\n'),
    hasSoul: Boolean(soul),
    hasMemory: Boolean(memoryBlock),
    hasInFlight: Boolean(inFlightBlock),
  };
}

export interface WritePreSessionPromptInput {
  agentKey: string;
  contentRoot: string;
  text: string;
  hasSoul?: boolean;
  hasMemory?: boolean;
  runtime?: 'claude' | 'codex';
}

export interface PreSessionContextRecord {
  hasSoul: boolean;
  hasMemory: boolean;
  runtime: string;
  generatedAt: string;
}

export interface WritePreSessionContextSidecarInput {
  agentKey: string;
  contentRoot: string;
  hasSoul: boolean;
  hasMemory: boolean;
  runtime: string;
}

/** Writes only the JSON sidecar used by runtime-health. Useful when there is no prompt text to persist (e.g. Codex, where startup memory is injected by a separate hook). */
export function writePreSessionContextSidecar(input: WritePreSessionContextSidecarInput): void {
  const dir = path.join(input.contentRoot, 'bridge', 'runtime-state');
  fs.mkdirSync(dir, { recursive: true });
  const context: PreSessionContextRecord = {
    hasSoul: input.hasSoul,
    hasMemory: input.hasMemory,
    runtime: input.runtime,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(dir, `${input.agentKey}-pre-session-context.json`),
    JSON.stringify(context, null, 2),
    'utf8',
  );
}

/**
 * Persists the pre-session prompt to a stable path under the runtime-state dir
 * so the underlying CLI can read it via `--append-system-prompt-file` and so
 * external observers (runtime-health, MCC UI) can inspect what was injected.
 * Also writes a JSON sidecar with soul/memory/runtime metadata for health checks.
 */
export function writePreSessionPromptFile(input: WritePreSessionPromptInput): string {
  const dir = path.join(input.contentRoot, 'bridge', 'runtime-state');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${input.agentKey}-pre-session.txt`);
  fs.writeFileSync(file, input.text, 'utf8');
  writePreSessionContextSidecar({
    agentKey: input.agentKey,
    contentRoot: input.contentRoot,
    hasSoul: input.hasSoul ?? false,
    hasMemory: input.hasMemory ?? false,
    runtime: input.runtime ?? 'unknown',
  });
  return file;
}

export function readPreSessionContextRecord(
  contentRoot: string,
  agentKey: string,
): PreSessionContextRecord | null {
  const sidecarPath = path.join(
    contentRoot,
    'bridge',
    'runtime-state',
    `${agentKey}-pre-session-context.json`,
  );
  try {
    return JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as PreSessionContextRecord;
  } catch {
    return null;
  }
}
