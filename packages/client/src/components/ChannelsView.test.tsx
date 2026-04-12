// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChannelsView } from './ChannelsView';

const mockChannelStore = vi.fn();

vi.mock('../stores/channelStore', () => ({
  useChannelStore: (selector: (state: any) => any) => mockChannelStore(selector),
}));

describe('ChannelsView', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
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
});
