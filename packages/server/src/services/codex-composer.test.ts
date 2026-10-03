import { describe, expect, it } from 'vitest';
import { codexPromptLeftComposer } from './codex-composer.js';

// Captured from Eli's pane, 2026-10-03 ~23:24Z: a Discord prompt logged `submitted`
// that never left the composer.
const STUCK = [
  '› [2026-10-03T10:30:29.310000+00:00] Eli: ```text',
  '  OB1 memory decision digest - 2026-10-03: 40 pending decisions.',
  '  </recent_discord_history>',
  '',
  '  [Messaging Gateway] Discord message routed for eli.',
  '',
  '  [Pasted Content 1166 chars]',
  '',
  '  Reply via `npm run discord:reply ...`',
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

describe('codexPromptLeftComposer', () => {
  it('reports the 2026-10-03 stuck paste as still pending', () => {
    expect(codexPromptLeftComposer(STUCK)).toBe(false);
  });

  it('reports a working turn as submitted', () => {
    expect(codexPromptLeftComposer(WORKING)).toBe(true);
  });

  it('reports an idle placeholder composer as submitted', () => {
    expect(codexPromptLeftComposer(IDLE)).toBe(true);
  });

  it('flags a long unsubmitted body even without a paste marker', () => {
    const body = `› ${'x'.repeat(300)}\n\n  GPT-5.6-Sol medium · /Volumes/Repo-Drive/agents/eli`;
    expect(codexPromptLeftComposer(body)).toBe(false);
  });

  it('returns null when it cannot read the screen or find the composer', () => {
    expect(codexPromptLeftComposer(null)).toBeNull();
    expect(codexPromptLeftComposer('no composer here')).toBeNull();
  });
});
