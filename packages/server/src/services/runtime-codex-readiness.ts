export interface CodexReadinessGate {
  onData(data: string): void;
  waitForIdle(): Promise<void>;
  hasReachedPrompt(): boolean;
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
  let reachedPrompt = false;
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

      // reachedPrompt is MONOTONIC — "has this session ever presented a prompt" — while
      // busy/idle is transient. Conflating them was the bug: the prompt marker used to be
      // evaluated only after the busy branches, each of which returns early, so a chunk
      // carrying both a busy-looking line and the prompt never set reachedPrompt at all.
      //
      // 2026-08-24: Eli's Codex TUI carries a persistent notice, "• You have 1 usage limit
      // reset available.", which matches the bullet glyph pattern below. Every full-screen
      // redraw emitted that notice and the prompt together, the busy branch matched and
      // returned, and reachedPrompt stayed false permanently. canInjectWithoutConfirmation()
      // is hasReachedPrompt(), so every inbound message deferred forever — 4 mails queued
      // unread, 171,655 readiness lines, seven hours, and a force-restart reproduced it.
      //
      // Evaluated unconditionally and FIRST. Narrowing the glyph pattern instead would be a
      // denylist of notices we happen to know about, and the next TUI restyle re-opens it.
      const hasPromptMarker = text.includes('\n› ') || text.startsWith('› ');
      if (hasPromptMarker) reachedPrompt = true;

      if (text.includes('Messages to be submitted after next tool call')) {
        setBusy(true, 'queued-input');
        return;
      }

      // Busy precedence is deliberately UNCHANGED. A chunk containing both a working marker
      // and a prompt still counts as busy, so waitForIdle() keeps gating actual submission;
      // only the monotonic reached-a-prompt fact escapes the early return.
      // `•` is deliberately NOT in the spinner set. It is an ordinary bullet: Eli's TUI
      // uses it for "• You have 1 usage limit reset available.", and Cecelia's pane carries
      // "• Cecelia's quick wrap-up" as prose. Matching it pinned Eli busy permanently —
      // exactly one gate transition after his 2026-08-24 restart, "-> busy (working)", and
      // never back to idle, so waitForIdle() could never resolve.
      //
      // Narrowing here is not the denylist I rejected for the ordering fix above: this drops
      // a character that was never a spinner frame, rather than enumerating the notices we
      // happen to have seen. `Working (` remains the primary busy signal, so a genuinely
      // working TUI is still detected even on a build that does render a bullet.
      if (/Working\s*\(/.test(text) || /[✱✻✽]\s+\S+/.test(text)) {
        setBusy(true, 'working');
        return;
      }

      if (hasPromptMarker) {
        setBusy(false, 'prompt-ready');
        flush();
      }
    },

    waitForIdle() {
      if (!busy) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },

    hasReachedPrompt() {
      return reachedPrompt;
    },
  };
}
