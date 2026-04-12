// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SearchPanel } from './SearchPanel';

const mockUseSearch = vi.fn();

vi.mock('../hooks/useSearch', () => ({
  useSearch: (agentKey: string) => mockUseSearch(agentKey),
}));

vi.mock('./ChatMessage', () => ({
  ChatMessage: ({ content, highlightedText, emphasis }: { content: string; highlightedText?: string; emphasis?: boolean }) => (
    <div>
      <div>{content}</div>
      {highlightedText ? <div>highlight:{highlightedText}</div> : null}
      {emphasis ? <div>emphasis:on</div> : null}
    </div>
  ),
}));

describe('SearchPanel', () => {
  const search = vi.fn();
  const clearSearch = vi.fn();
  const onClose = vi.fn();
  const onJumpToMessage = vi.fn();

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockUseSearch.mockReturnValue({
      query: 'learning',
      isSearching: false,
      totalResults: 2,
      error: null,
      search,
      clearSearch,
      results: [
        {
          seq: 7,
          role: 'assistant',
          content: 'Machine learning is a subset of artificial intelligence.',
          snippet: 'Machine learning is a subset of artificial intelligence.',
          timestamp: Date.now(),
          matchCount: 1,
        },
        {
          seq: 8,
          role: 'user',
          content: 'How does reinforcement learning differ?',
          snippet: 'How does reinforcement learning differ?',
          timestamp: Date.now(),
          matchCount: 1,
        },
      ],
    });
  });

  it('renders snippets with highlighted search text and lets users jump to the message', () => {
    render(<SearchPanel agentKey="marcus" onClose={onClose} onJumpToMessage={onJumpToMessage} />);

    expect(screen.getByText(/Found 2 messages matching/i)).toBeTruthy();
    expect(screen.getAllByText('highlight:learning')).toHaveLength(2);
    expect(screen.getAllByText('emphasis:on')).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: /jump to message/i })[1]);

    expect(onJumpToMessage).toHaveBeenCalledWith(8);
  });

  it('autofocuses the search input and supports arrow key navigation with enter to jump', () => {
    render(<SearchPanel agentKey="marcus" onClose={onClose} onJumpToMessage={onJumpToMessage} />);

    const input = screen.getByPlaceholderText(/search messages/i);
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onJumpToMessage).toHaveBeenCalledWith(8);
  });

  it('closes the search panel when escape is pressed', () => {
    render(<SearchPanel agentKey="marcus" onClose={onClose} onJumpToMessage={onJumpToMessage} />);

    fireEvent.keyDown(screen.getByPlaceholderText(/search messages/i), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
