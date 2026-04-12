import { execFileSync } from 'child_process';
import * as pty from 'node-pty';
import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';

const DEFAULT_SESSION = process.env.TMUX_SESSION ?? 'agents';

export class TmuxRelay {
  private sessions = new Map<string, pty.IPty>();

  attach(
    agentName: string,
    ws: WebSocket,
    size: { cols: number; rows: number }
  ): string {
    const session = process.env.TMUX_SESSION ?? 'agents';
    const term = pty.spawn('tmux', ['attach-session', '-t', `${session}:${agentName}`], {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });

    term.onData((data: string) => {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    });

    const id = randomUUID();
    this.sessions.set(id, term);
    return id;
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.resize(cols, rows);
  }

  detach(id: string): void {
    const term = this.sessions.get(id);
    if (term) {
      term.kill();
      this.sessions.delete(id);
    }
  }
}

export function listTmuxAgents(session = DEFAULT_SESSION): string[] {
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
