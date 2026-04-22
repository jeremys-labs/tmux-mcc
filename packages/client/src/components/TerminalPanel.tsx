import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useTerminal, type ConnectionStatus } from '../hooks/useTerminal.js';
import { useAgentStore } from '../stores/agentStore.js';
import { useUIStore } from '../stores/uiStore.js';
import '@xterm/xterm/css/xterm.css';

interface TerminalPanelProps {
  agentKey: string;
}

export function TerminalPanel({ agentKey }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // termRef: synchronous access for ResizeObserver (avoids stale closures)
  // terminal state: triggers useTerminal re-evaluation when xterm instance becomes available
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [scrolledUp, setScrolledUp] = useState(false);
  const [showTouchControls, setShowTouchControls] = useState(false);

  const agent = useAgentStore((s) => s.agents[agentKey]);
  const setMobileInfoOpen = useUIStore((s) => s.setMobileInfoOpen);
  // Use tmuxWindow if configured, fall back to agentKey
  const agentWindow = agent?.tmuxWindow ?? agentKey;

  // Initialize xterm.js Terminal once container is mounted
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: '#264f78',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
      },
      scrollback: 5000,
      // Leave EOL conversion to the shell/tmux — don't auto-convert \n to \r\n
      convertEol: false,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    // Fit after a brief delay so the container has dimensions
    requestAnimationFrame(() => fitAddon.fit());

    term.onScroll(() => {
      const buf = term.buffer.active;
      setScrolledUp(buf.viewportY < buf.baseY);
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;
    setTerminal(term);

    return () => {
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      setTerminal(null);
    };
  }, []); // Only run once on mount

  const { sendResize, sendData } = useTerminal({
    agentWindow,
    terminal,
    onStatusChange: setStatus,
  });

  // Resize terminal when container dimensions change
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      const addon = fitAddonRef.current;
      const term = termRef.current;
      if (!addon || !term) return;
      try {
        addon.fit();
        sendResize(term.cols, term.rows);
      } catch {
        // fit() can throw if terminal is not yet fully initialized
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [sendResize]);

  // Touch scroll — attach to xterm's own viewport element so events aren't swallowed by xterm
  useEffect(() => {
    if (!terminal) return;
    const viewport = terminal.element?.querySelector('.xterm-viewport');
    if (!viewport) return;

    let lastY = 0;

    const onTouchStart = (e: TouchEvent) => {
      lastY = e.touches[0].clientY;
    };

    const onTouchMove = (e: TouchEvent) => {
      const term = termRef.current;
      if (!term) return;
      const deltaY = lastY - e.touches[0].clientY;
      lastY = e.touches[0].clientY;
      const lineHeight = (term.options.fontSize ?? 13) * 1.5;
      const lines = Math.round(deltaY / lineHeight);
      if (lines !== 0) {
        term.scrollLines(lines);
        e.preventDefault();
      }
    };

    viewport.addEventListener('touchstart', onTouchStart as EventListener, { passive: true });
    viewport.addEventListener('touchmove', onTouchMove as EventListener, { passive: false });
    return () => {
      viewport.removeEventListener('touchstart', onTouchStart as EventListener);
      viewport.removeEventListener('touchmove', onTouchMove as EventListener);
    };
  }, [terminal]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const mediaQuery = window.matchMedia?.('(pointer: coarse), (hover: none)');
    const updateTouchControls = () => {
      setShowTouchControls(Boolean(mediaQuery?.matches || navigator.maxTouchPoints > 0));
    };

    updateTouchControls();
    mediaQuery?.addEventListener?.('change', updateTouchControls);

    return () => {
      mediaQuery?.removeEventListener?.('change', updateTouchControls);
    };
  }, []);

  const statusDot = {
    connecting: 'bg-yellow-400 animate-pulse',
    connected: 'bg-green-400',
    disconnected: 'bg-red-400',
  }[status];

  const statusText = {
    connecting: 'text-yellow-400',
    connected: 'text-green-400',
    disconnected: 'text-red-400',
  }[status];

  return (
    <div className="flex flex-col h-full" style={{ background: '#0d1117' }}>
      {/* Agent header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xl">{agent?.emoji ?? '🤖'}</span>
          <div>
            <span className="font-semibold text-white text-sm">{agent?.name ?? agentKey}</span>
            {agent?.role && (
              <span className="ml-2 text-xs text-white/50">{agent.role}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs ${statusText}`}>{status}</span>
          <div className={`w-2 h-2 rounded-full ${statusDot}`} />
          <button
            onClick={() => setMobileInfoOpen(true)}
            className="md:hidden text-xs text-text-secondary px-2 py-0.5 rounded border border-white/10"
          >
            Info
          </button>
        </div>
      </div>

      {/* Terminal container — relative wrapper gives FitAddon a concrete size to measure */}
      <div className="flex-1 overflow-hidden relative" style={{ minHeight: 0 }}>
        <div
          ref={containerRef}
          style={{ position: 'absolute', inset: '4px' }}
        />
        {scrolledUp && (
          <button
            onClick={() => {
              termRef.current?.scrollToBottom();
              setScrolledUp(false);
            }}
            className="absolute bottom-3 right-4 z-10 px-3 py-2 text-xs rounded bg-accent/80 hover:bg-accent text-white shadow"
          >
            ↓ Jump to bottom
          </button>
        )}
      </div>

      {showTouchControls && (
        <div className="flex flex-wrap items-center gap-1 px-2 py-1.5 border-t border-white/10 shrink-0 bg-[#0d1117]">
          <button
            onClick={() => sendData('\x1b')}
            className="px-2.5 py-1 text-xs font-mono rounded bg-white/10 hover:bg-white/20 text-white/80 active:bg-white/30"
          >
            ESC
          </button>
          <button
            onClick={() => sendData('\x03')}
            className="px-2.5 py-1 text-xs font-mono rounded bg-white/10 hover:bg-white/20 text-white/80 active:bg-white/30"
          >
            Ctrl+C
          </button>
          <button
            onClick={() => sendData('\x04')}
            className="px-2.5 py-1 text-xs font-mono rounded bg-white/10 hover:bg-white/20 text-white/80 active:bg-white/30"
          >
            Ctrl+D
          </button>
          <button
            onClick={() => sendData('\x1b[A')}
            aria-label="Arrow up"
            className="px-2.5 py-1 text-xs rounded bg-white/10 hover:bg-white/20 text-white/80 active:bg-white/30"
          >
            ↑
          </button>
          <button
            onClick={() => sendData('\x1b[B')}
            aria-label="Arrow down"
            className="px-2.5 py-1 text-xs rounded bg-white/10 hover:bg-white/20 text-white/80 active:bg-white/30"
          >
            ↓
          </button>
          <button
            onClick={() => sendData('\x1b[D')}
            aria-label="Arrow left"
            className="px-2.5 py-1 text-xs rounded bg-white/10 hover:bg-white/20 text-white/80 active:bg-white/30"
          >
            ←
          </button>
          <button
            onClick={() => sendData('\x1b[C')}
            aria-label="Arrow right"
            className="px-2.5 py-1 text-xs rounded bg-white/10 hover:bg-white/20 text-white/80 active:bg-white/30"
          >
            →
          </button>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => sendData(JSON.stringify({ type: 'scroll', direction: 'up' }))}
              className="px-2.5 py-1 text-xs rounded bg-white/10 hover:bg-white/20 text-white/80 active:bg-white/30"
            >
              PgUp
            </button>
            <button
              onClick={() => sendData(JSON.stringify({ type: 'scroll', direction: 'down' }))}
              className="px-2.5 py-1 text-xs rounded bg-white/10 hover:bg-white/20 text-white/80 active:bg-white/30"
            >
              PgDn
            </button>
            <button
              onClick={() => sendData(JSON.stringify({ type: 'scroll', direction: 'bottom' }))}
              className="px-2.5 py-1 text-xs rounded bg-white/10 hover:bg-white/20 text-white/80 active:bg-white/30"
            >
              Live
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
