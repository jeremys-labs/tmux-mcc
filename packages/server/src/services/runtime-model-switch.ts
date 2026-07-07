import { submitRuntimePrompt, type RuntimeWritablePty } from './runtime-pty.js';

export interface ModelSwitchResult {
  matched: boolean;
  model?: string;
}

const MODEL_ALIASES: Record<string, string> = {
  opus: 'opus',
  'opus 4.6': 'claude-opus-4-6',
  'opus 4.7': 'opus',
  'opus 4.8': 'opus',
  sonnet: 'sonnet',
  'sonnet 4.6': 'sonnet',
  haiku: 'haiku',
  'haiku 4.5': 'haiku',
  fable: 'claude-fable-5',
  'fable 5': 'claude-fable-5',
};

const MODEL_TOKEN = '(opus(?:\\s+4\\.[678])?|sonnet(?:\\s+4\\.6)?|haiku(?:\\s+4\\.5)?|fable(?:\\s+5)?)';

// Only honor an explicit *leading* command — "switch/change/set ... to/model <model>" or
// "use <model>" at the start of the message. This deliberately does NOT infer a switch from a
// model name buried in free text (e.g. "can you use sonnet-style headers"), which previously
// injected /model sonnet. The trailing boundary also stops "use sonnet-style" from matching.
const SWITCH_PATTERN = new RegExp(
  `^\\s*(?:(?:switch|change|set)\\b[^\\n]*?\\b(?:to|model)\\b\\s*|use\\s+)${MODEL_TOKEN}(?=[\\s.,!?)]|$)`,
  'i',
);

export function detectModelSwitch(text: string): ModelSwitchResult {
  const match = text.match(SWITCH_PATTERN);
  if (!match) return { matched: false };

  const raw = match[1].toLowerCase().replace(/\s+/g, ' ');
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
