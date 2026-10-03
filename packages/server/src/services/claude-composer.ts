/**
 * Claude Code's composer, read off the rendered tmux pane.
 *
 * Codex's equivalent (codex-composer.ts) cannot be reused: Claude's composer marker is
 * U+276F, not U+203A, and the footer is the model/permissions line rather than the
 * shortcuts line, so codexPromptLeftComposer returns null on every Claude screen.
 *
 * This decides one thing only: after writing `\r`, did the prompt we just injected leave
 * the composer? It answers from evidence we control -- a fingerprint of the injected text's
 * TAIL, or a paste placeholder -- rather than from a body-length threshold. A length rule
 * cannot tell an unsent prompt from a menu rendered with the same marker, and on this
 * surface the retry writes Enter into a live TTY.
 *
 * The tail, not the head: a composer holding a long value renders the region around the
 * cursor, which is the end. It is also what survived the 2026-10-03 splice -- the body was
 * lost and the tail of the reply instructions remained. Matching is whitespace-stripped
 * because the composer wraps and indents, so a raw substring match fails across a wrap.
 * Same rule as the Codex side, two surfaces.
 */

const COMPOSER_MARKER = '❯';

/** Claude Code footer/chrome lines that end the composer region. */
const FOOTER_LINE =
  /(bypass permissions)|(accept edits)|(plan mode)|(shift\+tab to cycle)|(for agents)|(─{4,})/;

/** Rendered while a turn is in flight. A working agent must never read as stuck. */
const BUSY_LINE = /(esc to interrupt)|(·\s*(Thinking|Working|Compacting))/;

/** Claude Code collapses a large paste to this placeholder. */
const PASTE_PLACEHOLDER = /\[Pasted (Content|text)/i;

/**
 * true  = the composer is clear, the prompt was submitted.
 * false = our prompt (or its paste placeholder) is still sitting in the composer.
 * null  = cannot tell; the caller must treat this as an absence, never as success.
 */
export function claudePromptLeftComposer(
  screen: string | null | undefined,
  fingerprint?: string,
): boolean | null {
  if (!screen) return null;
  if (BUSY_LINE.test(screen)) return true;

  const lines = screen.split('\n');
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trimStart().startsWith(COMPOSER_MARKER)) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  const body: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    if (i > start && FOOTER_LINE.test(lines[i])) break;
    body.push(lines[i]);
  }
  const text = body.join('\n');

  if (PASTE_PLACEHOLDER.test(text)) return false;
  if (fingerprint && fingerprint.length > 0 && stripWhitespace(text).includes(fingerprint)) {
    return false;
  }
  return true;
}

function stripWhitespace(value: string): string {
  return value.replace(/\s+/g, '');
}

/**
 * A whitespace-stripped slice of the END of the injected prompt, used to recognise it still
 * sitting in the composer. Returns '' when the prompt is too short to yield a distinctive
 * match, which disables fingerprint matching rather than matching loosely on a few chars.
 */
export function composerFingerprint(prompt: string, length = 40): string {
  const stripped = stripWhitespace(prompt);
  if (stripped.length < 16) return '';
  return stripped.slice(-length);
}
