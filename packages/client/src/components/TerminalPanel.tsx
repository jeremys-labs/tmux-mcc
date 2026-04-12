import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useTerminal, type ConnectionStatus } from '../hooks/useTerminal.js';
import { useAgentStore } from '../stores/agentStore.js';
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

  const agent = useAgentStore((s) => s.agents[agentKey]);
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

  const { sendResize } = useTerminal({
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
        <div className="flex items-center gap-1.5">
          <span className={`text-xs ${statusText}`}>{status}</span>
          <div className={`w-2 h-2 rounded-full ${statusDot}`} />
        </div>
      </div>

      {/* Terminal container — fills remaining height */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden"
        style={{ padding: '4px', minHeight: 0 }}
      />
    </div>
  );
}
