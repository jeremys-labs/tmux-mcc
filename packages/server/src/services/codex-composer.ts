/**
 * Reads a captured codex screen and answers: is a prompt still sitting unsubmitted in
 * the composer? true = submitted (or working), false = still pending, null = can't tell.
 *
 * The composer is the last line starting with `›` through the status line. An idle
 * composer holds a short placeholder; a stuck injection holds `[Pasted Content N chars]`
 * or a long multi-line body.
 */
const STATUS_LINE = /(\s·\s\/)|(\?\s+for shortcuts)/;
const UNSUBMITTED_BODY_CHARS = 200;

export function codexPromptLeftComposer(screen: string | null | undefined): boolean | null {
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
  const text = body.join('\n');
  if (text.includes('[Pasted Content')) return false;
  if (text.replace(/\s+/g, ' ').trim().length > UNSUBMITTED_BODY_CHARS) return false;
  return true;
}
