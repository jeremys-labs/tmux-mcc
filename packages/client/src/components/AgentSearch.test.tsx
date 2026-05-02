// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { AgentSearch } from './AgentSearch';

const mockResults = [
  {
    seq: 2,
    role: 'assistant',
    content: 'Machine learning is a subset of artificial intelligence.',
    timestamp: 1713100000000,
    agent: 'isla',
    matchIndex: 8,
    matchCount: 2,
    snippet: '…Machine learning is a subset of artificial intelligence…',
  },
  {
    seq: 1,
    role: 'user',
    content: 'Tell me about machine learning',
    timestamp: 1713099000000,
    agent: 'isla',
    matchIndex: 14,
    matchCount: 1,
    snippet: '…Tell me about machine learning…',
  },
];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Type into the search input, flush the debounce timer, and resolve all promises. */
async function typeAndSearch(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  // Run all fake timers (fires the debounce setTimeout)
  // then flush all queued microtasks/promises via the async variant
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

describe('AgentSearch', () => {
  it('renders a search input', () => {
    render(<AgentSearch agentKey="isla" onClose={vi.fn()} />);
    expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
  });

  it('fetches and displays results after typing a query', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: () => Promise.resolve({ results: mockResults, total: 2 }),
    } as Response);

    render(<AgentSearch agentKey="isla" onClose={vi.fn()} />);

    await typeAndSearch(screen.getByPlaceholderText(/search/i), 'machine');

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/search?agent=isla&q=machine')
    );
    // Text is split across a <mark> element — match via textContent of the <p>
    expect(screen.getByText((_, el) => el?.tagName === 'P' && /machine learning is a subset/i.test(el.textContent ?? ''))).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.tagName === 'P' && /tell me about machine learning/i.test(el.textContent ?? ''))).toBeInTheDocument();
  });

  it('shows a result count when results are returned', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: () => Promise.resolve({ results: mockResults, total: 2 }),
    } as Response);

    render(<AgentSearch agentKey="isla" onClose={vi.fn()} />);
    await typeAndSearch(screen.getByPlaceholderText(/search/i), 'machine');

    expect(screen.getByText(/2 result/i)).toBeInTheDocument();
  });

  it('shows "no results" when search returns empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: () => Promise.resolve({ results: [], total: 0 }),
    } as Response);

    render(<AgentSearch agentKey="isla" onClose={vi.fn()} />);
    await typeAndSearch(screen.getByPlaceholderText(/search/i), 'xyznotfound');

    expect(screen.getByText(/no results/i)).toBeInTheDocument();
  });

  it('does not fetch when query is fewer than 2 characters', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    render(<AgentSearch agentKey="isla" onClose={vi.fn()} />);
    await typeAndSearch(screen.getByPlaceholderText(/search/i), 'x');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<AgentSearch agentKey="isla" onClose={onClose} />);
    fireEvent.keyDown(screen.getByPlaceholderText(/search/i), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('labels each result with its role', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: () => Promise.resolve({ results: mockResults, total: 2 }),
    } as Response);

    render(<AgentSearch agentKey="isla" onClose={vi.fn()} />);
    await typeAndSearch(screen.getByPlaceholderText(/search/i), 'machine');

    expect(screen.getByText('assistant')).toBeInTheDocument();
    expect(screen.getByText('user')).toBeInTheDocument();
  });

  it('displays a formatted timestamp for each result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: () => Promise.resolve({ results: mockResults, total: 2 }),
    } as Response);

    render(<AgentSearch agentKey="isla" onClose={vi.fn()} />);
    await typeAndSearch(screen.getByPlaceholderText(/search/i), 'machine');

    const timestamps = screen.getAllByRole('time');
    expect(timestamps).toHaveLength(2);
    expect(timestamps[0]).toHaveAttribute('dateTime', new Date(mockResults[0].timestamp).toISOString());
    expect(timestamps[1]).toHaveAttribute('dateTime', new Date(mockResults[1].timestamp).toISOString());
  });

  it('highlights the matched query term inside each result snippet', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      json: () => Promise.resolve({ results: mockResults, total: 2 }),
    } as Response);

    render(<AgentSearch agentKey="isla" onClose={vi.fn()} />);
    await typeAndSearch(screen.getByPlaceholderText(/search/i), 'machine');

    // Every result snippet should contain a <mark> wrapping the matched term
    const marks = document.querySelectorAll('mark');
    expect(marks.length).toBeGreaterThanOrEqual(2);
    marks.forEach((m) => {
      expect(m.textContent?.toLowerCase()).toBe('machine');
    });
  });
});
