import { execFileSync } from 'child_process';
import * as pty from 'node-pty';
import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';

function getSession(): string {
  return process.env.TMUX_SESSION ?? 'agents';
}

interface PtySession {
  term: pty.IPty;
  dataDisposable: { dispose(): void };
}

export class TmuxRelay {
  private sessions = new Map<string, PtySession>();

  attach(
    agentName: string,
    ws: WebSocket,
    size: { cols: number; rows: number }
  ): string {
    const session = getSession();
    const term = pty.spawn('tmux', ['attach-session', '-t', `${session}:${agentName}`], {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });

    const dataDisposable = term.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    const id = randomUUID();
    this.sessions.set(id, { term, dataDisposable });
    return id;
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.term.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.term.resize(cols, rows);
  }

  detach(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.dataDisposable.dispose();
      session.term.kill();
      this.sessions.delete(id);
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
