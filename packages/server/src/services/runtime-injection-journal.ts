import fs from 'fs';
import path from 'path';

export type InjectionSource = 'discord' | 'agent-mail' | 'bluebubbles' | 'handoff' | 'unknown';

export interface InjectionJournalEntry {
  ts: string;
  source: InjectionSource;
  promptLength: number; // char count only — never raw text (injected prompts may carry sensitive content)
}

// Rotate when the journal file exceeds this size; keep the most recent ROTATION_TARGET entries.
const MAX_JOURNAL_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB
const ROTATION_TARGET_ENTRIES = 500;

export function resolveInjectionJournalPath(contentRoot: string, agentKey: string): string {
  return path.join(contentRoot, 'bridge', 'injection-journal', `${agentKey}.jsonl`);
}

function rotateIfNeeded(journalPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(journalPath);
  } catch {
    return; // file does not exist yet
  }
  if (stat.size < MAX_JOURNAL_SIZE_BYTES) return;

  const text = fs.readFileSync(journalPath, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  const trimmed = lines.slice(-ROTATION_TARGET_ENTRIES).join('\n') + '\n';
  fs.writeFileSync(journalPath, trimmed);
}

export function appendInjectionJournalEntry(
  contentRoot: string,
  agentKey: string,
  entry: InjectionJournalEntry,
): void {
  const journalPath = resolveInjectionJournalPath(contentRoot, agentKey);
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  rotateIfNeeded(journalPath);
  fs.appendFileSync(journalPath, `${JSON.stringify(entry)}\n`);
}
