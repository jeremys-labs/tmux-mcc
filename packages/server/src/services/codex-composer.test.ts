import { describe, expect, it } from 'vitest';
import { codexPromptLeftComposer } from './codex-composer.js';

const PROMPT_TAIL = 'replies). chat_id="1491979880747765810". Reply on Discord, not only the local session.';
const PROMPT = `[Answer Context] ...long context...\n${PROMPT_TAIL}`;

// Captured from Eli's pane, 2026-10-03 ~23:24Z: a Discord prompt logged `submitted`
// that never left the composer. Note the tail is re-wrapped with indentation.
const STUCK = [
  '› [2026-10-03T10:30:29.310000+00:00] Eli: ```text',
  '  [Messaging Gateway] Discord message routed for eli.',
  '',
  '  [Pasted Content 1166 chars]',
  '',
  '  Reply via `npm run discord:reply --workspace=@mcc-tmux/server --prefix /',
  '  Volumes/Repo-Drive/src/mcc-tmux -- --agent eli --chat-id 1491979880747765810',
  '  --text-file /absolute/path/to/reply.txt` (or `--text` for short shell-safe',
  '  replies). chat_id="1491979880747765810". Reply on Discord, not only the local',
  '  session.',
  '',
  '  GPT-5.6-Sol medium · /Volumes/Repo-Drive/agents/eli · Rerun required startup …',
  '                                                       ⚠ 1 warning · f2 to view',
].join('\n');

const WORKING = [
  '• Working (7s • esc to interrupt)',
  '',
  '› Ask Codex to do anything',
  '',
  '  GPT-5.6-Sol medium · /Volumes/Repo-Drive/agents/eli · Rerun required startup …',
].join('\n');

const IDLE = [
  '• Sent to Discord and verified delivery.',
  '',
  '› Ask Codex to do anything',
  '',
  '  GPT-5.6-Sol medium · /Volumes/Repo-Drive/agents/eli · Rerun required startup …',
  '  ? for shortcuts                                      ⚠ 1 warning · f2 to view',
].join('\n');

// Marcus's case: a trust menu renders with the same glyph. A long one must never read
// as an unsent prompt, or a retry presses Enter on "Trust and continue".
const LONG_MENU = [
  'Do you trust the contents of this directory? ' + 'Working with untrusted contents comes with higher risk. '.repeat(6),
  '› 1. Yes, continue',
  '  2. No, quit',
  '',
  '  Press enter to continue',
].join('\n');

describe('codexPromptLeftComposer', () => {
  it('reports the 2026-10-03 stuck paste as still pending', () => {
    expect(codexPromptLeftComposer(STUCK, PROMPT)).toBe(false);
  });

  it('recognises the injected tail even when the paste marker is absent', () => {
    const noMarker = STUCK.replace('  [Pasted Content 1166 chars]', '');
    expect(codexPromptLeftComposer(noMarker, PROMPT)).toBe(false);
  });

  it('catches a SHORT unsent residue (length thresholds missed this)', () => {
    const shortPrompt = 'ping eli: are you there?';
    const screen = `› ${shortPrompt}\n\n  GPT-5.6-Sol medium · /Volumes/Repo-Drive/agents/eli`;
    expect(codexPromptLeftComposer(screen, shortPrompt)).toBe(false);
  });

  it('never reads a long menu as an unsent prompt', () => {
    expect(codexPromptLeftComposer(LONG_MENU, PROMPT)).toBe(true);
  });

  it('reports a working turn as submitted', () => {
    expect(codexPromptLeftComposer(WORKING, PROMPT)).toBe(true);
  });

  it('reports an idle placeholder composer as submitted', () => {
    expect(codexPromptLeftComposer(IDLE, PROMPT)).toBe(true);
  });

  it('returns null when it cannot read the screen or find the composer', () => {
    expect(codexPromptLeftComposer(null, PROMPT)).toBeNull();
    expect(codexPromptLeftComposer('no composer here', PROMPT)).toBeNull();
  });
});
