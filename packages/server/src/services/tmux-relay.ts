import { execFileSync } from 'child_process';

const DEFAULT_SESSION = process.env.TMUX_SESSION ?? 'agents';

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
