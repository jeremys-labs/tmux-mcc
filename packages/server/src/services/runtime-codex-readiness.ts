export interface CodexReadinessGate {
  onData(data: string): void;
  waitForIdle(): Promise<void>;
}

export interface CodexReadinessGateOptions {
  /**
   * Called only when the gate's busy/idle state actually changes, with the glyph/marker that
   * drove it. Surfaces gate transitions in the runtime log so a Codex TUI restyle that silently
   * degrades the glyph matching is visible instead of failing quietly.
   */
  onTransition?: (state: 'busy' | 'idle', marker: string) => void;
}

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function createCodexReadinessGate(options: CodexReadinessGateOptions = {}): CodexReadinessGate {
  let busy = false;
  let waiters: Array<() => void> = [];

  const setBusy = (next: boolean, marker: string) => {
    if (busy !== next) {
      busy = next;
      options.onTransition?.(next ? 'busy' : 'idle', marker);
    } else {
      busy = next;
    }
  };

  const flush = () => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };

  return {
    onData(data) {
      const text = stripAnsi(data);
      if (text.includes('Messages to be submitted after next tool call')) {
        setBusy(true, 'queued-input');
        return;
      }

      if (/Working\s*\(/.test(text) || /[•✱✻✽]\s+\S+/.test(text)) {
        setBusy(true, 'working');
        return;
      }

      if (text.includes('\n› ') || text.startsWith('› ')) {
        setBusy(false, 'prompt-ready');
        flush();
      }
    },

    waitForIdle() {
      if (!busy) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}
