export interface CodexReadinessGate {
  onData(data: string): void;
  waitForIdle(): Promise<void>;
}

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function createCodexReadinessGate(): CodexReadinessGate {
  let busy = false;
  let waiters: Array<() => void> = [];

  const flush = () => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };

  return {
    onData(data) {
      const text = stripAnsi(data);
      if (text.includes('Messages to be submitted after next tool call')) {
        busy = true;
        return;
      }

      if (/Working\s*\(/.test(text) || /[•✱✻✽]\s+\S+/.test(text)) {
        busy = true;
        return;
      }

      if (text.includes('\n› ') || text.startsWith('› ')) {
        busy = false;
        flush();
      }
    },

    waitForIdle() {
      if (!busy) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}
