// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TerminalPanel } from './TerminalPanel';

const sendData = vi.fn();

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    cols = 80;
    rows = 24;
    buffer = { active: { viewportY: 0, baseY: 0 } };
    element = document.createElement('div');
    options = { fontSize: 13 };

    loadAddon() {}
    open() {}
    write() {}
    scrollLines() {}
    scrollToBottom() {}
    dispose() {}
    onScroll() {
      return { dispose() {} };
    }
    attachCustomKeyEventHandler() {}
  }

  return { Terminal: MockTerminal };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class MockFitAddon {
    fit() {}
  },
}));

vi.mock('../hooks/useTerminal.js', () => ({
  useTerminal: () => ({
    sendResize: vi.fn(),
    sendData,
  }),
}));

vi.mock('../stores/agentStore.js', () => ({
  useAgentStore: (selector: (state: unknown) => unknown) => selector({
    agents: {
      marcus: {
        name: 'Marcus',
        emoji: '🔧',
        role: 'Dev Lead',
      },
    },
  }),
}));

vi.mock('../stores/uiStore.js', () => ({
  useUIStore: (selector: (state: unknown) => unknown) => selector({
    setMobileInfoOpen: vi.fn(),
  }),
}));

beforeEach(() => {
  sendData.mockReset();
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  Object.defineProperty(window.navigator, 'maxTouchPoints', {
    configurable: true,
    value: 5,
  });
  window.matchMedia = vi.fn().mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
});

describe('TerminalPanel search', () => {
  it('opens the search panel when the search button is clicked', () => {
    render(<TerminalPanel agentKey="marcus" />);
    expect(screen.queryByPlaceholderText(/search conversation/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Search conversation history' }));

    expect(screen.getByPlaceholderText(/search conversation/i)).toBeInTheDocument();
  });

  it('closes the search panel when the AgentSearch close button is clicked', () => {
    render(<TerminalPanel agentKey="marcus" />);

    fireEvent.click(screen.getByRole('button', { name: 'Search conversation history' }));
    expect(screen.getByPlaceholderText(/search conversation/i)).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Close search (Esc)'));
    expect(screen.queryByPlaceholderText(/search conversation/i)).not.toBeInTheDocument();
  });

  it('opens the search panel when Ctrl+F is pressed', () => {
    render(<TerminalPanel agentKey="marcus" />);
    expect(screen.queryByPlaceholderText(/search conversation/i)).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });

    expect(screen.getByPlaceholderText(/search conversation/i)).toBeInTheDocument();
  });

  it('opens the search panel when Cmd+F is pressed (Mac)', () => {
    render(<TerminalPanel agentKey="marcus" />);
    expect(screen.queryByPlaceholderText(/search conversation/i)).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'f', metaKey: true });

    expect(screen.getByPlaceholderText(/search conversation/i)).toBeInTheDocument();
  });

  it('closes the search panel when Ctrl+F is pressed while open', () => {
    render(<TerminalPanel agentKey="marcus" />);

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
    expect(screen.getByPlaceholderText(/search conversation/i)).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });
    expect(screen.queryByPlaceholderText(/search conversation/i)).not.toBeInTheDocument();
  });
});

describe('TerminalPanel touch controls', () => {
  it('shows shortcut keys on touch devices including iPad-sized viewports', () => {
    render(<TerminalPanel agentKey="marcus" />);

    expect(screen.getByRole('button', { name: 'ESC' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ctrl+C' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Arrow up' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'PgUp' })).toBeInTheDocument();
  });

  it('sends escape sequences and tmux scroll commands from the touch controls', () => {
    render(<TerminalPanel agentKey="marcus" />);

    fireEvent.click(screen.getByRole('button', { name: 'ESC' }));
    fireEvent.click(screen.getByRole('button', { name: 'Arrow left' }));
    fireEvent.click(screen.getByRole('button', { name: 'PgDn' }));

    expect(sendData).toHaveBeenNthCalledWith(1, '\x1b');
    expect(sendData).toHaveBeenNthCalledWith(2, '\x1b[D');
    expect(sendData).toHaveBeenNthCalledWith(3, JSON.stringify({ type: 'scroll', direction: 'down' }));
  });
});
