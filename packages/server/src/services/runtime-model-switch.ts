import { submitRuntimePrompt, type RuntimeWritablePty } from './runtime-pty.js';

export interface ModelSwitchResult {
  matched: boolean;
  model?: string;
}

const MODEL_ALIASES: Record<string, string> = {
  opus: 'opus',
  'opus 4.6': 'claude-opus-4-6',
  'opus 4.7': 'opus',
  sonnet: 'sonnet',
  'sonnet 4.6': 'sonnet',
  haiku: 'haiku',
  'haiku 4.5': 'haiku',
};

const SWITCH_PATTERN = /\b(?:switch|change|set)\b.*?\b(?:to|model)\b.*?\b(opus(?:\s+4\.[67])?|sonnet(?:\s+4\.6)?|haiku(?:\s+4\.5)?)\b|\buse\b.*?\b(opus(?:\s+4\.[67])?|sonnet(?:\s+4\.6)?|haiku(?:\s+4\.5)?)\b/i;

export function detectModelSwitch(text: string): ModelSwitchResult {
  const match = text.match(SWITCH_PATTERN);
  if (!match) return { matched: false };

  const raw = (match[1] ?? match[2]).toLowerCase();
  const model = MODEL_ALIASES[raw] ?? raw;
  return { matched: true, model };
}

export async function injectModelSwitch(
  term: RuntimeWritablePty,
  model: string,
): Promise<void> {
  await submitRuntimePrompt(term, `/model ${model}`, {
    clearDelayMs: 40,
    submitDelayMs: 200,
  });
  // Wait for the model switch to take effect before the next prompt
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
