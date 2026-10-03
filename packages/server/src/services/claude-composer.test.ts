import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { claudePromptLeftComposer, composerFingerprint } from './claude-composer.js';

const LIVE_PANE = fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'claude-pane-live.txt'),
  'utf8',
);

// Footer chrome copied verbatim from the live capture, so the region scan is pinned to the
// real screen rather than to an invented one.
const FOOTER = [
  '  Opus 5 in marcus [████████░░░░░░░░░░░░] 42%',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');

const PROMPT = [
  '[Messaging Gateway] Discord message routed to marcus',
  'Jeremy: here is a long message body that must survive injection intact.',
  'Reply with: npm run discord:reply -- --agent marcus --chat-id 1492892431543308439',
].join('\n');

function screenWithComposer(body: string): string {
  return ['  Ran 2 shell commands', '', `❯ ${body}`, FOOTER].join('\n');
}

describe('claudePromptLeftComposer', () => {
  it('reads the real live pane as submitted, because the agent is working', () => {
    // Positive control: a busy agent must never be reported stuck, or the retry presses
    // Enter into a turn that is already running.
    expect(claudePromptLeftComposer(LIVE_PANE, composerFingerprint(PROMPT))).toBe(true);
  });

  it('reports submitted when the composer is empty', () => {
    expect(claudePromptLeftComposer(screenWithComposer(''), composerFingerprint(PROMPT))).toBe(true);
  });

  it('reports pending when the prompt tail is still in the composer', () => {
    const tail = PROMPT.slice(-120);
    expect(claudePromptLeftComposer(screenWithComposer(tail), composerFingerprint(PROMPT))).toBe(false);
  });

  it('reports pending when the tail is wrapped and indented across lines', () => {
    // The composer wraps and indents. Without whitespace-stripped matching this case reads
    // as submitted, which is the silent direction: the prompt sits there and nothing retries.
    const tail = PROMPT.slice(-120);
    const mid = Math.floor(tail.length / 2);
    const wrapped = `${tail.slice(0, mid)}\n     ${tail.slice(mid)}`;
    expect(claudePromptLeftComposer(screenWithComposer(wrapped), composerFingerprint(PROMPT))).toBe(false);
  });

  it('reports pending on a paste placeholder even with no fingerprint match', () => {
    expect(claudePromptLeftComposer(screenWithComposer('[Pasted text #1 +84 lines]'), composerFingerprint(PROMPT))).toBe(false);
  });

  it('reports submitted for an unrelated long composer body with no fingerprint', () => {
    // A menu or someone else's draft rendered with the same marker must NOT read as our
    // unsent prompt. A body-length rule fails this and sends Enter into a live menu.
    // Long in real characters, not whitespace: a whitespace-padded body collapses under a
    // length rule and would pass either way, pinning nothing.
    const menu = [
      '1. Yes, run it',
      '  2. No, and tell Claude what to do differently',
      '  3. Yes, and do not ask again for commands matching: pnpm --filter @frontdeskco/api test --run --reporter=verbose --coverage --passWithNoTests',
      '  4. Review the full command before running it in this workspace directory',
    ].join('\n');
    expect(claudePromptLeftComposer(screenWithComposer(menu), composerFingerprint(PROMPT))).toBe(true);
  });

  it('cannot tell when no composer marker is on screen', () => {
    expect(claudePromptLeftComposer('  Ran 2 shell commands\n' + FOOTER, composerFingerprint(PROMPT))).toBeNull();
  });

  it('cannot tell when the screen is unreadable', () => {
    expect(claudePromptLeftComposer('', composerFingerprint(PROMPT))).toBeNull();
    expect(claudePromptLeftComposer(null, composerFingerprint(PROMPT))).toBeNull();
  });

  it('cannot tell on a Codex screen, so the two predicates never cross-apply', () => {
    const codex = ['› Ask Codex to do anything', '  ? for shortcuts'].join('\n');
    expect(claudePromptLeftComposer(codex, composerFingerprint(PROMPT))).toBeNull();
  });
});

describe('composerFingerprint', () => {
  it('takes the stripped tail of the prompt', () => {
    const fp = composerFingerprint(PROMPT);
    expect(fp).toHaveLength(40);
    expect(PROMPT.replace(/\s+/g, '')).toContain(fp);
    expect(PROMPT.replace(/\s+/g, '').endsWith(fp)).toBe(true);
  });

  it('returns empty for a prompt too short to match distinctively', () => {
    expect(composerFingerprint('ok')).toBe('');
  });
});
