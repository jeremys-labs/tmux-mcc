// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DashboardLayout } from './DashboardLayout';

const mockUIStore = vi.fn();

vi.mock('../stores/uiStore', () => ({
  useUIStore: () => mockUIStore(),
}));

vi.mock('../components/ConnectionStatus', () => ({
  ConnectionStatus: () => <div>connection-status</div>,
}));

describe('DashboardLayout navigation', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockUIStore.mockReturnValue({
      activeView: 'office',
      setView: vi.fn(),
    });
  });

  it('exposes the channels view in desktop and mobile navigation', () => {
    render(
      <DashboardLayout>
        <div>content</div>
      </DashboardLayout>
    );

    expect(screen.getAllByRole('button', { name: /channels/i }).length).toBeGreaterThan(0);
  });

  it('switches to channels when the nav item is clicked', () => {
    const setView = vi.fn();
    mockUIStore.mockReturnValue({
      activeView: 'office',
      setView,
    });

    render(
      <DashboardLayout>
        <div>content</div>
      </DashboardLayout>
    );

    fireEvent.click(screen.getAllByRole('button', { name: /channels/i })[0]);

    expect(setView).toHaveBeenCalledWith('channels');
  });
});
