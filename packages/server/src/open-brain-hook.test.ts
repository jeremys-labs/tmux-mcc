import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { formatStartupMemoryForClaude } from './services/open-brain-runtime.js';

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
});
