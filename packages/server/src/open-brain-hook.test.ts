import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { formatStartupMemoryForClaude } from './services/open-brain-runtime.js';
import {
  extractPromptText,
  formatClaudeAdditionalContext,
  formatCodexSystemMessage,
  inferAgentKey,
  parseOpenBrainHookArgs,
} from './services/open-brain-harness-hook.js';

describe('open brain Claude hook helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('formats Claude startup memory as additional context content', () => {
    const formatted = formatStartupMemoryForClaude('isla', 'Found memory');

    expect(formatted).toContain('[Open Brain Startup Recall] Governed memory retrieved for isla.');
    expect(formatted).toContain('<memory_context source="open-brain" agent_id="isla">');
    expect(formatted).toContain('Found memory');
    expect(formatted).toContain('capture durable conclusions through governed agent memory');
  });

  it('parses hook command and output format', () => {
    expect(parseOpenBrainHookArgs(['answer-context', '--format', 'codex'])).toEqual({
      command: 'answer-context',
      outputFormat: 'codex',
    });
    expect(parseOpenBrainHookArgs(['session-start'])).toEqual({
      command: 'session-start',
      outputFormat: 'claude',
    });
  });

  it('infers agent key from hook cwd before env fallback', () => {
    expect(inferAgentKey({ cwd: '/Volumes/Repo-Drive/agents/remy' })).toBe('remy');
    expect(inferAgentKey({}, { cwd: '/tmp/work', env: { AGENT_KEY: 'eli' } })).toBe('eli');
  });

  it('extracts prompt text across runtime payload shapes', () => {
    expect(extractPromptText({ userPrompt: 'What is dinner?' })).toBe('What is dinner?');
    expect(extractPromptText({ input: 'Daily weigh-in' })).toBe('Daily weigh-in');
  });

  it('formats runtime-specific hook output envelopes', () => {
    expect(JSON.parse(formatClaudeAdditionalContext('UserPromptSubmit', 'context'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'context',
      },
    });
    expect(JSON.parse(formatCodexSystemMessage('context'))).toEqual({
      continue: true,
      systemMessage: 'context',
    });
  });
});
