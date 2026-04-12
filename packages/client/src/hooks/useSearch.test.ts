import { describe, it, expect } from 'vitest';
import { searchMessages } from './useSearch';

describe('searchMessages utility', () => {
  const testMessages = [
    { seq: 1, role: 'user' as const, content: 'Tell me about Python', timestamp: 1000 },
    { seq: 2, role: 'assistant' as const, content: 'Python is a programming language', timestamp: 2000 },
    { seq: 3, role: 'user' as const, content: 'What about TypeScript?', timestamp: 3000 },
    { seq: 4, role: 'assistant' as const, content: 'TypeScript adds types to JavaScript', timestamp: 4000 },
  ];

  it('should filter messages by search term', () => {
    const results = searchMessages(testMessages, 'Python');
    expect(results).toHaveLength(2);
    expect(results[0].content).toContain('Python');
    expect(results[1].content).toContain('Python');
  });

  it('should be case-insensitive', () => {
    const results = searchMessages(testMessages, 'python');
    expect(results).toHaveLength(2);
  });

  it('should search partial matches', () => {
    const results = searchMessages(testMessages, 'Script');
    expect(results).toHaveLength(2);
    expect(results.every(m => m.content.toLowerCase().includes('script'))).toBe(true);
  });

  it('should return empty array for no matches', () => {
    const results = searchMessages(testMessages, 'Rust');
    expect(results).toEqual([]);
  });

  it('should preserve message order', () => {
    const results = searchMessages(testMessages, 'a');
    expect(results[0].seq).toBeLessThan(results[results.length - 1].seq);
  });
});
