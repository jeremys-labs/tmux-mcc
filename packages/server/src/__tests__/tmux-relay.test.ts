import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TmuxRelay } from '../services/tmux-relay.js';

const mockTerm = {
  onData: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
};

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => mockTerm),
}));

describe('TmuxRelay', () => {
  let relay: TmuxRelay;

  beforeEach(() => {
    vi.clearAllMocks();
    // onData needs to store callback so tests can trigger it
    mockTerm.onData.mockImplementation((cb: (data: string) => void) => {
      (mockTerm as any)._dataCallback = cb;
    });
    relay = new TmuxRelay();
  });

  it('spawns a PTY attaching to the named tmux window', async () => {
    const pty = await import('node-pty');
    const mockWs = { send: vi.fn(), readyState: 1 };

    relay.attach('marcus', mockWs as any, { cols: 220, rows: 50 });

    expect(pty.spawn).toHaveBeenCalledWith(
      'tmux',
      ['attach-session', '-t', 'agents:marcus'],
      expect.objectContaining({ cols: 220, rows: 50, name: 'xterm-256color' })
    );
  });

  it('forwards PTY output to the WebSocket', async () => {
    const mockWs = { send: vi.fn(), readyState: 1 };
    relay.attach('marcus', mockWs as any, { cols: 220, rows: 50 });

    // Simulate PTY data arriving
    (mockTerm as any)._dataCallback?.('hello world');

    expect(mockWs.send).toHaveBeenCalledWith('hello world');
  });

  it('does not send to closed WebSocket', async () => {
    const mockWs = { send: vi.fn(), readyState: 3 }; // 3 = CLOSED
    relay.attach('marcus', mockWs as any, { cols: 220, rows: 50 });

    (mockTerm as any)._dataCallback?.('hello world');

    expect(mockWs.send).not.toHaveBeenCalled();
  });

  it('kills PTY on detach', () => {
    const mockWs = { send: vi.fn(), readyState: 1 };
    const id = relay.attach('marcus', mockWs as any, { cols: 220, rows: 50 });
    relay.detach(id);

    expect(mockTerm.kill).toHaveBeenCalled();
  });

  it('resizes PTY on resize call', () => {
    const mockWs = { send: vi.fn(), readyState: 1 };
    const id = relay.attach('marcus', mockWs as any, { cols: 220, rows: 50 });
    relay.resize(id, 100, 30);

    expect(mockTerm.resize).toHaveBeenCalledWith(100, 30);
  });

  it('silently ignores resize for unknown session id', () => {
    expect(() => relay.resize('nonexistent', 100, 30)).not.toThrow();
  });

  it('silently ignores detach for unknown session id', () => {
    expect(() => relay.detach('nonexistent')).not.toThrow();
  });
});
