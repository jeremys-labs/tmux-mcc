import { describe, it, expect } from 'vitest';
import { resolveAgentModels, formatModelName } from './models.js';

describe('formatModelName', () => {
  it('formats anthropic claude model IDs', () => {
    expect(formatModelName('anthropic/claude-haiku-4-5')).toBe('Haiku 4.5');
    expect(formatModelName('anthropic/claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(formatModelName('anthropic/claude-opus-4-5')).toBe('Opus 4.5');
  });

  it('formats openai model IDs', () => {
    expect(formatModelName('openai-codex/gpt-5.2')).toBe('GPT 5.2');
    expect(formatModelName('openai/gpt-5.3-codex')).toBe('GPT 5.3 Codex');
  });

  it('returns the raw model part for unknown formats', () => {
    expect(formatModelName('custom/some-model')).toBe('some-model');
  });
});

describe('resolveAgentModels', () => {
  it('returns global default when agent has no override', () => {
    const result = resolveAgentModels(
      ['isla', 'marcus'],
      {
        defaults: { model: { primary: 'anthropic/claude-haiku-4-5' } },
        list: [
          { id: 'isla' },
          { id: 'marcus' },
        ],
      }
    );
    expect(result.isla).toBe('Haiku 4.5');
    expect(result.marcus).toBe('Haiku 4.5');
  });

  it('returns per-agent override when present', () => {
    const result = resolveAgentModels(
      ['eli'],
      {
        defaults: { model: { primary: 'anthropic/claude-haiku-4-5' } },
        list: [
          { id: 'eli', model: { primary: 'anthropic/claude-sonnet-4-6' } },
        ],
      }
    );
    expect(result.eli).toBe('Sonnet 4.6');
  });

  it('returns empty string when no model config exists', () => {
    const result = resolveAgentModels(
      ['alice'],
      { list: [{ id: 'alice' }] }
    );
    expect(result.alice).toBe('');
  });
});
