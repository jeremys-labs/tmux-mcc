import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripAnsi } from './chat.js';

describe('task_completed payload text usage', () => {
  const file = fs.readFileSync(path.join(__dirname, 'chat.ts'), 'utf8');

  it('uses text from task_completed payload when available', () => {
    // The handler should read payload.text from the task_completed event
    // (provided by the harness adapter's cleanOutput method) rather than
    // re-running stripAnsi on accumulated raw PTY output.
    // Look for the specific pattern used to extract text in task_completed:
    // (event.payload as Record<string, unknown>)?.text as string ?? ...
    const taskCompletedIndex = file.indexOf("type === 'task_completed'");
    expect(taskCompletedIndex).toBeGreaterThan(-1);
    // Find the payload.text pattern that appears after the task_completed check
    const afterTaskCompleted = file.slice(taskCompletedIndex);
    expect(afterTaskCompleted).toContain("payload as Record<string, unknown>)?.text as string");
  });

  it('uses text from waiting_for_input payload when available', () => {
    const waitingIndex = file.indexOf("type === 'waiting_for_input'");
    const allPayloadOccurrences = [...file.matchAll(/payload as Record<string, unknown>\)[\?!]\.text/g)];
    // There should be at least 2 occurrences — one for task_completed, one for waiting_for_input
    expect(allPayloadOccurrences.length).toBeGreaterThanOrEqual(2);
    expect(waitingIndex).toBeGreaterThan(-1);
  });
});

describe('stripAnsi', () => {
  it('leaves plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('removes color/style CSI sequences', () => {
    expect(stripAnsi('\x1b[37mEnter\x1b[39m')).toBe('Enter');
  });

  it('removes OSC sequences (e.g. title bar)', () => {
    expect(stripAnsi('\x1b]0;✳ session\x07rest')).toBe('rest');
  });

  it('replaces cursor-movement codes with a space so words do not concatenate', () => {
    // \x1b[1C is "move cursor right 1" — visually a space in the terminal
    expect(stripAnsi('Enter\x1b[1Cto confirm')).toBe('Enter to confirm');
  });

  it('removes DEC private CSI sequences with > parameter byte (e.g. \\x1b[>0q)', () => {
    // \x1b[>0q is a "query keyboard options" DEC sequence — > is a valid CSI param byte
    expect(stripAnsi('\x1b[>0q')).toBe('');
    expect(stripAnsi('hello\x1b[>0qworld')).toBe('helloworld');
  });

  it('produces no visible artifacts from a real session startup chunk', () => {
    // Actual output seen when eli session started — contained [>0q4mu artifacts
    const raw = '\x1b[>0q\x1b[4m\x1b[u';
    const result = stripAnsi(raw);
    expect(result).toBe('');
  });

  it('handles real PTY waiting_for_input chunk without losing word boundaries', () => {
    const raw = '\u001b[?2026h\r\u001b[1C\u001b[1A\u001b[37mEnter\u001b[1Cto confirm \xb7\u001b[1CEsc to cancel\u001b[39m\r\r\n\u001b[?2026l';
    const result = stripAnsi(raw);
    expect(result).toContain('Enter');
    expect(result).toContain('to confirm');
    // "Enter" and "to" must not be directly adjacent
    expect(result).not.toMatch(/Enter\S+to/);
  });
});
