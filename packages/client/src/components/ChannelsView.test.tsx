// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ChannelsView } from './ChannelsView';

const mockChannelStore = vi.fn();
const mockAgentStore = vi.fn();

vi.mock('../stores/channelStore', () => ({
  useChannelStore: (selector: (state: any) => any) => mockChannelStore(selector),
}));

vi.mock('../stores/agentStore', () => ({
  useAgentStore: (selector: (state: any) => any) => mockAgentStore(selector),
}));

describe('ChannelsView', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    // Default: no agents known
    mockAgentStore.mockImplementation((selector: (state: any) => any) =>
      selector({ agents: {} })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls for new interactions every 30 seconds', () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();

    mockChannelStore.mockImplementation((selector: (state: any) => any) =>
      selector({ interactions: [], loading: false, fetch: fetchMock })
    );

    render(<ChannelsView />);

    // Called once on mount
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => { vi.advanceTimersByTime(30_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    act(() => { vi.advanceTimersByTime(30_000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('renders recent agent interactions and supports filtering by agent name', () => {
    mockChannelStore.mockImplementation((selector: (state: any) => any) =>
      selector({
        interactions: [
          {
            from: 'Marcus',
            to: 'Eli',
            content: 'Please review the websocket retry flow.',
            type: 'review',
            timestamp: new Date('2026-04-11T19:45:00Z').getTime(),
          },
          {
            from: 'Nova',
            to: 'Isla',
            content: 'Daily standup summary is ready.',
            type: 'update',
            timestamp: new Date('2026-04-11T19:15:00Z').getTime(),
          },
        ],
        loading: false,
        fetch: vi.fn(),
      })
    );

    render(<ChannelsView />);

    expect(screen.getByText(/agent channels/i)).toBeTruthy();
    expect(screen.getByText(/Please review the websocket retry flow./i)).toBeTruthy();
    expect(screen.getByText(/Daily standup summary is ready./i)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/filter interactions/i), {
      target: { value: 'Marcus' },
    });

    expect(screen.getByText(/Please review the websocket retry flow./i)).toBeTruthy();
    expect(screen.queryByText(/Daily standup summary is ready./i)).toBeNull();
  });

  it('shows a helpful empty state when no interactions are available', () => {
    mockChannelStore.mockImplementation((selector: (state: any) => any) =>
      selector({
        interactions: [],
        loading: false,
        fetch: vi.fn(),
      })
    );

    render(<ChannelsView />);

    expect(screen.getByText(/no recent agent interactions yet/i)).toBeTruthy();
    expect(screen.getByText(/when agents start coordinating/i)).toBeTruthy();
  });

  it('does not show a clear button when the filter is empty', () => {
    mockChannelStore.mockImplementation((selector: (state: any) => any) =>
      selector({ interactions: [], loading: false, fetch: vi.fn() })
    );

    render(<ChannelsView />);

    expect(screen.queryByRole('button', { name: /clear filter/i })).toBeNull();
  });

  it('shows a clear button when the filter has text, and clicking it resets the filter', () => {
    mockChannelStore.mockImplementation((selector: (state: any) => any) =>
      selector({
        interactions: [
          {
            from: 'Marcus',
            to: 'Eli',
            content: 'Please review the websocket retry flow.',
            type: 'review',
            timestamp: new Date('2026-04-11T19:45:00Z').getTime(),
          },
          {
            from: 'Nova',
            to: 'Isla',
            content: 'Daily standup summary is ready.',
            type: 'update',
            timestamp: new Date('2026-04-11T19:15:00Z').getTime(),
          },
        ],
        loading: false,
        fetch: vi.fn(),
      })
    );

    render(<ChannelsView />);

    const input = screen.getByPlaceholderText(/filter interactions/i);

    fireEvent.change(input, { target: { value: 'Marcus' } });
    expect(screen.queryByText(/Daily standup summary is ready./i)).toBeNull();

    const clearBtn = screen.getByRole('button', { name: /clear filter/i });
    expect(clearBtn).toBeTruthy();

    fireEvent.click(clearBtn);
    expect((input as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/Daily standup summary is ready./i)).toBeTruthy();
  });

  it('clears the filter when Escape is pressed in the filter input', () => {
    mockChannelStore.mockImplementation((selector: (state: any) => any) =>
      selector({
        interactions: [
          {
            from: 'Marcus',
            to: 'Eli',
            content: 'Please review the websocket retry flow.',
            type: 'review',
            timestamp: new Date('2026-04-11T19:45:00Z').getTime(),
          },
        ],
        loading: false,
        fetch: vi.fn(),
      })
    );

    render(<ChannelsView />);

    const input = screen.getByPlaceholderText(/filter interactions/i);
    fireEvent.change(input, { target: { value: 'something' } });
    expect((input as HTMLInputElement).value).toBe('something');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('shows a no-match message (not the generic empty state) when filter matches nothing', () => {
    mockChannelStore.mockImplementation((selector: (state: any) => any) =>
      selector({
        interactions: [
          {
            from: 'Marcus',
            to: 'Eli',
            content: 'Please review the websocket retry flow.',
            type: 'review',
            timestamp: new Date('2026-04-11T19:45:00Z').getTime(),
          },
        ],
        loading: false,
        fetch: vi.fn(),
      })
    );

    render(<ChannelsView />);

    fireEvent.change(screen.getByPlaceholderText(/filter interactions/i), {
      target: { value: 'zzznomatch' },
    });

    // Should NOT show the generic "no interactions yet" message
    expect(screen.queryByText(/no recent agent interactions yet/i)).toBeNull();
    // Should show a filter-specific message
    expect(screen.getByText(/no interactions match/i)).toBeTruthy();
  });

  it('shows a clear-filter link in the no-match state that resets the filter', () => {
    mockChannelStore.mockImplementation((selector: (state: any) => any) =>
      selector({
        interactions: [
          {
            from: 'Marcus',
            to: 'Eli',
            content: 'Please review the websocket retry flow.',
            type: 'review',
            timestamp: new Date('2026-04-11T19:45:00Z').getTime(),
          },
        ],
        loading: false,
        fetch: vi.fn(),
      })
    );

    render(<ChannelsView />);

    const input = screen.getByPlaceholderText(/filter interactions/i);
    fireEvent.change(input, { target: { value: 'zzznomatch' } });

    // The no-match empty state shows an inline "clear the filter" link-button
    const clearLink = screen.getByText(/clear the filter/i);
    fireEvent.click(clearLink);

    expect((input as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/Please review the websocket retry flow./i)).toBeTruthy();
  });

  it('shows "X of Y interactions" count when filter is active and has results', () => {
    mockChannelStore.mockImplementation((selector: (state: any) => any) =>
      selector({
        interactions: [
          {
            from: 'Marcus',
            to: 'Eli',
            content: 'Please review the websocket retry flow.',
            type: 'review',
            timestamp: new Date('2026-04-11T19:45:00Z').getTime(),
          },
          {
            from: 'Nova',
            to: 'Isla',
            content: 'Daily standup summary is ready.',
            type: 'update',
            timestamp: new Date('2026-04-11T19:15:00Z').getTime(),
          },
        ],
        loading: false,
        fetch: vi.fn(),
      })
    );

    render(<ChannelsView />);

    // Without filter: shows total count only
    expect(screen.getByText(/showing 2 recent interactions/i)).toBeTruthy();

    // With active filter matching 1 of 2
    fireEvent.change(screen.getByPlaceholderText(/filter interactions/i), {
      target: { value: 'Marcus' },
    });

    expect(screen.getByText(/1 of 2/i)).toBeTruthy();
  });

  it('shows agent emoji when the agent key is known', () => {
    mockAgentStore.mockImplementation((selector: (state: any) => any) =>
      selector({
        agents: {
          marcus: { name: 'Marcus', emoji: '🔧', role: 'Dev Lead' },
          isla: { name: 'Isla', emoji: '🌟', role: 'PM' },
        },
      })
    );

    mockChannelStore.mockImplementation((selector: (state: any) => any) =>
      selector({
        interactions: [
          {
            from: 'marcus',
            to: 'isla',
            content: 'PR is ready.',
            type: 'handoff',
            timestamp: new Date('2026-05-09T12:00:00Z').getTime(),
          },
        ],
        loading: false,
        fetch: vi.fn(),
      })
    );

    render(<ChannelsView />);

    expect(screen.getByText(/🔧/)).toBeTruthy();
    expect(screen.getByText(/🌟/)).toBeTruthy();
  });
});
