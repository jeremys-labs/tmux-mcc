import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as nodePty from 'node-pty';
import * as childProcess from 'child_process';
import { WebSocket } from 'ws';
import { TmuxRelay } from '../services/tmux-relay.js';

const mockTerm = {
  onData: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  dispose: vi.fn(),
};

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => mockTerm),
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

describe('TmuxRelay', () => {
  let relay: TmuxRelay;

  beforeEach(() => {
    vi.clearAllMocks();
    // onData needs to store callback so tests can trigger it, and return a disposable
    mockTerm.onData.mockImplementation((cb: (data: string) => void) => {
      (mockTerm as any)._dataCallback = cb;
      return { dispose: mockTerm.dispose };
    });
    relay = new TmuxRelay();
  });

  it('creates a per-client grouped tmux session and spawns a PTY attached to it', () => {
    const mockWs = { send: vi.fn(), readyState: WebSocket.OPEN };

    relay.attach('marcus', mockWs as any, { cols: 220, rows: 50 });

    const mockExec = vi.mocked(childProcess.execFileSync);

    // Should create a per-client grouped session with the agents session
    expect(mockExec).toHaveBeenCalledWith(
      'tmux',
      ['new-session', '-d', '-s', expect.stringMatching(/^mcc-/), '-t', 'agents'],
      expect.anything()
    );
    // Then explicitly select the target agent's window in the new session
    expect(mockExec).toHaveBeenCalledWith(
      'tmux',
      ['select-window', '-t', expect.stringMatching(/^mcc-.*:marcus$/)],
      expect.anything()
    );

    // PTY should attach to the per-client session, not the shared agents session
    expect(vi.mocked(nodePty.spawn)).toHaveBeenCalledWith(
      'tmux',
      ['attach-session', '-t', expect.stringMatching(/^mcc-/)],
      expect.objectContaining({ cols: 220, rows: 50, name: 'xterm-256color' })
    );
  });

  it('forwards PTY output to the WebSocket', () => {
    const mockWs = { send: vi.fn(), readyState: WebSocket.OPEN };
    relay.attach('marcus', mockWs as any, { cols: 220, rows: 50 });

    // Simulate PTY data arriving
    (mockTerm as any)._dataCallback?.('hello world');

    expect(mockWs.send).toHaveBeenCalledWith('hello world');
  });

  it('does not send to closed WebSocket', () => {
    const mockWs = { send: vi.fn(), readyState: WebSocket.CLOSED };
    relay.attach('marcus', mockWs as any, { cols: 220, rows: 50 });

    (mockTerm as any)._dataCallback?.('hello world');

    expect(mockWs.send).not.toHaveBeenCalled();
  });

  it('writes input data to PTY', () => {
    const mockWs = { send: vi.fn(), readyState: WebSocket.OPEN };
    const id = relay.attach('marcus', mockWs as any, { cols: 220, rows: 50 });
    relay.write(id, 'ls -la\n');
    expect(mockTerm.write).toHaveBeenCalledWith('ls -la\n');
  });

  it('kills PTY and per-client session on detach', () => {
    const mockWs = { send: vi.fn(), readyState: WebSocket.OPEN };
    const id = relay.attach('marcus', mockWs as any, { cols: 220, rows: 50 });
    relay.detach(id);

    expect(mockTerm.kill).toHaveBeenCalled();

    // Should kill the per-client mcc-* session on disconnect
    expect(vi.mocked(childProcess.execFileSync)).toHaveBeenCalledWith(
      'tmux', ['kill-session', '-t', expect.stringMatching(/^mcc-/)], expect.anything()
    );

    // After detach, write and resize should be no-ops
    relay.write(id, 'should not throw');
    relay.resize(id, 80, 24);
    // If the session was properly removed, write would not call mockTerm.write again
    expect(mockTerm.write).not.toHaveBeenCalled();
  });

  it('resizes PTY on resize call', () => {
    const mockWs = { send: vi.fn(), readyState: WebSocket.OPEN };
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
