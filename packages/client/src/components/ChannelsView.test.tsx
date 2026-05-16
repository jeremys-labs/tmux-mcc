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
