import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  appendInjectionJournalEntry,
  resolveInjectionJournalPath,
  type InjectionJournalEntry,
} from './runtime-injection-journal.js';

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inj-journal-test-'));
}

describe('runtime-injection-journal', () => {
  let contentRoot: string;

  beforeEach(() => {
    contentRoot = makeTmpRoot();
  });

  it('creates the journal directory and writes a JSONL entry', () => {
    appendInjectionJournalEntry(contentRoot, 'eli', {
      ts: '2026-06-07T12:00:00.000Z',
      source: 'discord',
      promptLength: 42,
    });
    const journalPath = resolveInjectionJournalPath(contentRoot, 'eli');
    const lines = fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as InjectionJournalEntry;
    expect(entry.source).toBe('discord');
    expect(entry.promptLength).toBe(42);
    expect(entry.ts).toBe('2026-06-07T12:00:00.000Z');
  });

  it('stores promptLength but never raw prompt text', () => {
    appendInjectionJournalEntry(contentRoot, 'marcus', {
      ts: new Date().toISOString(),
      source: 'agent-mail',
      promptLength: 99,
    });
    const journalPath = resolveInjectionJournalPath(contentRoot, 'marcus');
    const raw = fs.readFileSync(journalPath, 'utf8');
    // The only numeric field is the count — no free-form text stored
    expect(Object.keys(JSON.parse(raw.trim()))).toEqual(['ts', 'source', 'promptLength']);
  });

  it('appends multiple entries in order', () => {
    for (let i = 0; i < 3; i++) {
      appendInjectionJournalEntry(contentRoot, 'nova', {
        ts: new Date().toISOString(),
        source: 'handoff',
        promptLength: i * 10,
      });
    }
    const journalPath = resolveInjectionJournalPath(contentRoot, 'nova');
    const lines = fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect((JSON.parse(lines[2]) as InjectionJournalEntry).promptLength).toBe(20);
  });

  it('rotates to last 500 entries when journal exceeds 1MB', () => {
    const journalPath = resolveInjectionJournalPath(contentRoot, 'isla');
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });

    // Write ~600 entries of ~2KB each to exceed 1MB
    const bigEntry = JSON.stringify({
      ts: '2026-06-07T00:00:00.000Z',
      source: 'discord',
      promptLength: 1800,
      // pad to ~2KB — normally entries are ~80B but we need to trigger the 1MB guard
      _pad: 'x'.repeat(1800),
    });
    for (let i = 0; i < 600; i++) {
      fs.appendFileSync(journalPath, `${bigEntry}\n`);
    }

    // One more write triggers the rotation
    appendInjectionJournalEntry(contentRoot, 'isla', {
      ts: '2026-06-07T01:00:00.000Z',
      source: 'agent-mail',
      promptLength: 5,
    });

    const lines = fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean);
    // After rotation: last 500 of the 600 originals + the new entry = 501
    expect(lines.length).toBe(501);
    // Last entry is the newly appended one
    expect((JSON.parse(lines[lines.length - 1]) as InjectionJournalEntry).promptLength).toBe(5);
  });

  it('is a no-op when journal is under size limit', () => {
    appendInjectionJournalEntry(contentRoot, 'remy', {
      ts: '2026-06-07T12:00:00.000Z',
      source: 'bluebubbles',
      promptLength: 100,
    });
    appendInjectionJournalEntry(contentRoot, 'remy', {
      ts: '2026-06-07T12:00:01.000Z',
      source: 'discord',
      promptLength: 200,
    });
    const journalPath = resolveInjectionJournalPath(contentRoot, 'remy');
    const lines = fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
  });
});
