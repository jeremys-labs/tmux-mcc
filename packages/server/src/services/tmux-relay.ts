import { execFileSync } from 'child_process';
import * as pty from 'node-pty';
import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { agentStatusBroadcaster } from './agent-status-broadcaster.js';

function getSession(): string {
  return process.env.TMUX_SESSION ?? 'agents';
}

const AWAITING_INPUT_TIMEOUT_MS = 2500;
// How long after user sends input to ignore onData (suppress echo-as-thinking).
// User input echo arrives in <10ms; real agent output takes hundreds of ms+.
const ECHO_SUPPRESS_MS = 200;

interface PtySession {
  agentName: string;
  term: pty.IPty;
  dataDisposable: { dispose(): void };
  quietTimer: ReturnType<typeof setTimeout> | null;
  echoSuppressTimer: ReturnType<typeof setTimeout> | null;
  suppressEcho: boolean;
}

export class TmuxRelay {
  private sessions = new Map<string, PtySession>();

  attach(
    agentName: string,
    ws: WebSocket,
    size: { cols: number; rows: number }
  ): string {
    const session = getSession();

    // Pre-load tmux scrollback history so the user can scroll up through
    // the full Claude Code conversation, not just what arrived after connect.
    try {
      const scrollback = execFileSync(
        'tmux',
        ['capture-pane', '-t', `${session}:${agentName}`, '-p', '-e', '-S', '-5000', '-E', '-1'],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      if (scrollback.trim()) {
        ws.send(scrollback.replace(/\n/g, '\r\n'));
      }
    } catch {
      // Pane may not exist or have no scrollback yet — continue silently
    }

    const term = pty.spawn('tmux', ['attach-session', '-t', `${session}:${agentName}`], {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });

    const id = randomUUID();
    const ptySession: PtySession = {
      agentName, term, dataDisposable: { dispose: () => {} },
      quietTimer: null, echoSuppressTimer: null, suppressEcho: false,
    };
    this.sessions.set(id, ptySession);

    // User is now viewing this agent — clear any notification badge
    agentStatusBroadcaster.broadcast(agentName, 'idle');

    const dataDisposable = term.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
      // Skip status update if this is just the pty echoing user input back
      if (ptySession.suppressEcho) return;
      // Status: agent is producing real output → thinking
      if (ptySession.quietTimer) clearTimeout(ptySession.quietTimer);
      agentStatusBroadcaster.broadcast(agentName, 'thinking');
      // After silence, agent is awaiting input
      ptySession.quietTimer = setTimeout(() => {
        agentStatusBroadcaster.broadcast(agentName, 'awaiting_input');
        ptySession.quietTimer = null;
      }, AWAITING_INPUT_TIMEOUT_MS);
    });

    ptySession.dataDisposable = dataDisposable;
    return id;
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.quietTimer) clearTimeout(session.quietTimer);
    // Suppress onData echo for a short window — echo arrives in <10ms,
    // real agent output arrives hundreds of ms later after Claude processes
    session.suppressEcho = true;
    if (session.echoSuppressTimer) clearTimeout(session.echoSuppressTimer);
    session.echoSuppressTimer = setTimeout(() => {
      session.suppressEcho = false;
      session.echoSuppressTimer = null;
    }, ECHO_SUPPRESS_MS);
    session.term.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.term.resize(cols, rows);
  }

  detach(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      if (session.quietTimer) clearTimeout(session.quietTimer);
      if (session.echoSuppressTimer) clearTimeout(session.echoSuppressTimer);
      session.dataDisposable.dispose();
      session.term.kill();
      this.sessions.delete(id);
      agentStatusBroadcaster.broadcast(session.agentName, 'idle');
    }
  }
}

export function listTmuxAgents(session = getSession()): string[] {
  try {
    const output = execFileSync(
      'tmux',
      ['list-windows', '-t', session, '-F', '#{window_name}'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return output
      .split('\n')
      .map((s: string) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
