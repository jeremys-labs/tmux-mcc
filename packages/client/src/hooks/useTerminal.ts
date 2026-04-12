import { useEffect, useRef, useCallback } from 'react';
import type { Terminal } from '@xterm/xterm';

// Exported so TerminalPanel can share the same type without duplication
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

interface UseTerminalOptions {
  agentWindow: string;  // the tmux window name (may differ from agentKey)
  terminal: Terminal | null;
  // Must be stable (e.g. from useState setter) — an inline arrow fn would cause reconnect storms
  onStatusChange?: (status: ConnectionStatus) => void;
}

export function useTerminal({ agentWindow, terminal, onStatusChange }: UseTerminalOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);
  const mountedRef = useRef(true);

  const sendResize = useCallback((cols: number, rows: number) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }, []);

  const connect = useCallback(() => {
    if (!terminal || !mountedRef.current) return;

    onStatusChange?.('connecting');

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const { cols, rows } = terminal;
    const ws = new WebSocket(`${protocol}//${location.host}/ws/terminal/${agentWindow}`);
    // Note: browser WebSocket doesn't support custom headers — use URL query params for size
    // The server will use defaults (220x50) if not provided; resize message sent on connect

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      attemptsRef.current = 0;
      onStatusChange?.('connected');
      // Send initial size
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    };

    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        terminal.write(e.data);
      } else {
        (e.data as Blob).arrayBuffer().then((buf: ArrayBuffer) => terminal.write(new Uint8Array(buf)));
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      onStatusChange?.('disconnected');
      wsRef.current = null;
      // Exponential backoff: 3s base, 1.5x multiplier, 30s cap
      const delay = Math.min(3000 * Math.pow(1.5, attemptsRef.current++), 30000);
      reconnectTimerRef.current = setTimeout(connect, delay);
    };

    ws.onerror = (e) => {
      if (import.meta.env.DEV) console.warn('[useTerminal] WebSocket error:', e);
      ws.close();
    };

    wsRef.current = ws;
  }, [agentWindow, terminal, onStatusChange]);

  // Forward terminal keystrokes to WebSocket
  useEffect(() => {
    if (!terminal) return;
    const disposable = terminal.onData((data) => {
      wsRef.current?.send(data);
    });
    return () => disposable.dispose();
  }, [terminal]);

  // Connect on mount, clean up on unmount
  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { sendResize };
}
