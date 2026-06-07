import { describe, expect, it } from 'vitest';
import { normalizeInlineDiscordText } from './discord-reply-text.js';

describe('normalizeInlineDiscordText', () => {
  it('turns shell-escaped newlines into Discord newlines', () => {
    expect(normalizeInlineDiscordText('Heading\\n\\n1. First\\n2. Second'))
      .toBe('Heading\n\n1. First\n2. Second');
  });

  it('normalizes escaped CRLF newlines without leaving carriage returns', () => {
    expect(normalizeInlineDiscordText('First\\r\\nSecond')).toBe('First\nSecond');
  });

  it('leaves existing newlines and unrelated escapes unchanged', () => {
    expect(normalizeInlineDiscordText('First\nSecond\\tTabbed')).toBe('First\nSecond\\tTabbed');
  });
});
