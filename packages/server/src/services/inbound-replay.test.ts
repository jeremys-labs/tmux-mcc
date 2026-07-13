import { describe, expect, it } from 'vitest';
import {
  decideReplay,
  buildReplayEntry,
  parseInboxLines,
  findEntry,
  hasReplayOf,
  type InboxEntryLike,
  type ReplayDecisionInput,
} from './inbound-replay.js';

// REGRESSION FIXTURE — the real 2026-07-09 incident, verbatim shape.
// Jeremy's message 1524925527146627202 ("That seems to work. Can you send me
// that reply about Israel...") was queued for cecelia, the bridge cursor
// advanced over it into a session that died before processing (cursor 23/23,
// inbox had 23 lines), and no outbound send followed. Recovery was manual
// tmux surgery. This is the state replay MUST accept.
const LOST_MESSAGE: InboxEntryLike = {
  id: '1524925527146627202',
  agentKey: 'cecelia',
  channelId: '1521320561156948058',
  content: 'That seems to work. Can you send me that reply about Israel and prostitution?',
  bindingName: 'cecelia',
};

const INCIDENT_7_09: ReplayDecisionInput = {
  entry: LOST_MESSAGE,
  entryIndex: 22,          // last line of a 23-line inbox (0-based)
  cursorLineCount: 23,     // cursor fully advanced — consumed
  queuedAt: '2026-07-09T23:49:00.000Z',
  outboundSends: [
    // her joke, sent long BEFORE this message was queued — must not count as an answer
    { sent_at: '2026-07-09T23:17:00.000Z', agent: 'cecelia', chat_id: '1521320561156948058' },
  ],
  alreadyReplayed: false,
  liveness: { processStatus: 'dead', progressStatus: 'unknown' },
};

describe('decideReplay — the 7/9 incident regression', () => {
  it('ACCEPTS the real consumed-but-unprocessed dead-session state', () => {
    const decision = decideReplay(INCIDENT_7_09);
    expect(decision.ok).toBe(true);
  });

  it('refuses a second replay of the same message (dedupe marker is load-bearing)', () => {
    const decision = decideReplay({ ...INCIDENT_7_09, alreadyReplayed: true });
    expect(decision).toMatchObject({ ok: false, klass: 'already_replayed' });
  });

  it('already_replayed is NOT overridable by --force (no double delivery, ever)', () => {
    const decision = decideReplay({ ...INCIDENT_7_09, alreadyReplayed: true, force: true });
    expect(decision).toMatchObject({ ok: false, klass: 'already_replayed' });
  });
});

describe('decideReplay — orphaned-state precondition gate (Isla R1 condition)', () => {
  it('refuses when the session is alive and actively processing (double-delivery risk)', () => {
    const decision = decideReplay({
      ...INCIDENT_7_09,
      liveness: { processStatus: 'running', progressStatus: 'processing' },
    });
    expect(decision).toMatchObject({ ok: false, klass: 'session_active' });
  });

  it('allows replay when the session is running but idle (message provably dropped)', () => {
    const decision = decideReplay({
      ...INCIDENT_7_09,
      liveness: { processStatus: 'running', progressStatus: 'idle' },
    });
    expect(decision.ok).toBe(true);
  });

  it('--force overrides session_active with the forced flag set', () => {
    const decision = decideReplay({
      ...INCIDENT_7_09,
      liveness: { processStatus: 'running', progressStatus: 'processing' },
      force: true,
    });
    expect(decision).toMatchObject({ ok: true, forced: true });
  });

  it('refuses when the supervisor is unreachable (cannot prove orphaned state)', () => {
    const decision = decideReplay({ ...INCIDENT_7_09, liveness: null });
    expect(decision).toMatchObject({ ok: false, klass: 'liveness_unknown' });
  });
});

describe('decideReplay — other refusals', () => {
  it('refuses a still-queued message (wake, not replay)', () => {
    const decision = decideReplay({ ...INCIDENT_7_09, entryIndex: 22, cursorLineCount: 22 });
    expect(decision).toMatchObject({ ok: false, klass: 'not_consumed' });
  });

  it('refuses when an outbound send followed the queue time (already answered)', () => {
    const decision = decideReplay({
      ...INCIDENT_7_09,
      outboundSends: [
        { sent_at: '2026-07-09T23:55:00.000Z', agent: 'cecelia', chat_id: '1521320561156948058' },
      ],
    });
    expect(decision).toMatchObject({ ok: false, klass: 'already_answered' });
  });

  it('a send to a DIFFERENT chat does not count as an answer', () => {
    const decision = decideReplay({
      ...INCIDENT_7_09,
      outboundSends: [
        { sent_at: '2026-07-09T23:55:00.000Z', agent: 'cecelia', chat_id: '9999' },
      ],
    });
    expect(decision.ok).toBe(true);
  });

  it('refuses an unknown message id', () => {
    const decision = decideReplay({ ...INCIDENT_7_09, entry: null, entryIndex: -1 });
    expect(decision).toMatchObject({ ok: false, klass: 'not_found' });
  });
});

describe('replay entry construction and inbox scanning', () => {
  it('preserves the original entry verbatim and adds only replayed_from', () => {
    const replay = buildReplayEntry(LOST_MESSAGE);
    expect(replay.id).toBe(LOST_MESSAGE.id);
    expect(replay.content).toBe(LOST_MESSAGE.content);
    expect(replay.channelId).toBe(LOST_MESSAGE.channelId);
    expect(replay.replayed_from).toBe(LOST_MESSAGE.id);
  });

  it('hasReplayOf detects the marker; findEntry skips replay entries as targets', () => {
    const lines = [
      JSON.stringify(LOST_MESSAGE),
      JSON.stringify(buildReplayEntry(LOST_MESSAGE)),
    ].join('\n');
    const entries = parseInboxLines(lines);
    expect(hasReplayOf(entries, LOST_MESSAGE.id)).toBe(true);
    // The replay copy itself must never be selected as a replay target.
    const found = findEntry(entries, LOST_MESSAGE.id);
    expect(found.index).toBe(0);
  });

  it('parseInboxLines skips torn lines', () => {
    const entries = parseInboxLines(`${JSON.stringify(LOST_MESSAGE)}\n{"id":"trunc`);
    expect(entries).toHaveLength(1);
  });
});
