/**
 * Reads a captured codex screen and answers: is the prompt we just injected still
 * sitting unsubmitted in the composer? true = submitted (or working), false = still
 * pending, null = can't tell.
 *
 * The composer is the last line starting with `›` through the status line. Pending is
 * decided by RECOGNITION, not size: the composer holds a fingerprint of the injected
 * prompt's tail, or codex's own `[Pasted Content N chars]` collapse marker. A length
 * threshold (the first version) could mistake a long trust menu -- same glyph, and its
 * highlighted item is "Trust and continue" -- for an unsent prompt and press Enter into
 * it, and it read a short unsent residue as submitted. Marcus, 2026-10-03.
 */
const STATUS_LINE = /(\s·\s\/)|(\?\s+for shortcuts)/;
const FINGERPRINT_CHARS = 32;

function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}

export function promptFingerprint(prompt: string): string {
  return stripWhitespace(prompt).slice(-FINGERPRINT_CHARS);
}

export function codexPromptLeftComposer(screen: string | null | undefined, prompt: string): boolean | null {
  if (!screen) return null;
  if (screen.includes('esc to interrupt')) return true;
  const lines = screen.split('\n');
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trimStart().startsWith('›')) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  const body: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    if (i > start && STATUS_LINE.test(lines[i])) break;
    body.push(lines[i]);
  }
  const composer = body.join('\n');
  if (composer.includes('[Pasted Content')) return false;
  const fingerprint = promptFingerprint(prompt);
  if (fingerprint && stripWhitespace(composer).includes(fingerprint)) return false;
  return true;
}
