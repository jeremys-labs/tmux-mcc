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
  /**
   * Observability for events that are NOT state changes. Today that is only a dropped
   * over-long fragment. A cap set too low would make the change-rule silently inert —
   * every fragment discarded, nothing ever compared, the gate held busy forever, i.e. the
   * original bug with a fix installed and no signal. This is how that shows up in the log
   * the first time rather than being debugged from symptoms weeks later.
   */
  onNotice?: (message: string) => void;
}

/**
 * A busy marker that is STATIC across frames is decoration; one that CHANGES is work.
 *
 * 2026-08-24: Eli's TUI carried "• You have 1 usage limit reset available." co-present with
 * the prompt in every full redraw. Busy matched first and returned, the prompt branch was
 * never reached, and the gate stayed pinned for seven hours — 4 mails unread, 171,655
 * readiness lines. Two fixes followed (prompt-marker evaluated first; `•` dropped from the
 * spinner set) and BOTH ARE INSTANCES, NOT THE CLASS: they removed the two markers that
 * happened to be permanent.
 *
 * A time lease does not close the class either, and this is the part that took three design
 * rounds to see: the notice was RE-RENDERED ON EVERY FRAME, so "must be re-asserted within a
 * window" is a condition a permanent decoration satisfies perfectly. Decay releases a marker
 * that STOPS appearing; the failure mode is a marker that NEVER STOPS appearing.
 *
 * So the discriminator is change. `Working (12s ...)` increments, spinners animate — that is
 * what makes them progress indicators rather than decoration. The comparison is the COMPLETE
 * LINE, never the regex match: /Working\s*\(/ matches exactly "Working (", byte-identical
 * forever however hard the agent is working, so comparing the match would release a working
 * TUI to idle.
 *
 * Nothing is ever concluded from an absence: no data means nothing is evaluated and the gate
 * holds. Truncation applies to the LOG only — comparing truncated lines would make two long
 * busy lines sharing a prefix compare equal, which is the same false-idle by another route.
 */
const STATIC_BUSY_FRAME_LIMIT = 20;
/** Bounds an unterminated PTY stream. Generous on purpose: it exists to stop a newline-free
 *  stream eating memory, NOT to bound a line — a tight cap would drop every real line and
 *  make the mechanism inert while looking installed. */
const PARTIAL_LINE_CAP = 8192;
/** Log-side only. Never used for the comparison. */
const LOGGED_LINE_CAP = 160;

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function createCodexReadinessGate(options: CodexReadinessGateOptions = {}): CodexReadinessGate {
  let busy = false;
  let reachedPrompt = false;
  let waiters: Array<() => void> = [];
  let partial = '';
  let lastBusyLine: string | null = null;
  let staticBusyFrames = 0;
  let droppedFragments = 0;
  /**
   * A line already PROVEN to be decoration. Without this the release is useless: the very
   * next redraw carries the same static line and re-pins the gate immediately, so it flaps
   * once per frame and delivery is no better off. Found by running the release test, not by
   * reading the design. A decoration stops holding the gate until it CHANGES — at which
   * point it is work again and pins normally.
   */
  let decorationLine: string | null = null;

  const setBusy = (next: boolean, marker: string) => {
    if (busy !== next) {
      busy = next;
      options.onTransition?.(next ? 'busy' : 'idle', marker);
    } else {
      busy = next;
    }
  };

  const isBusyLine = (line: string): boolean =>
    /Working\s*\(/.test(line) || /[✱✻✽]\s+\S+/.test(line);

  /** Control-stripped and bounded, with a digest when truncated, so a diagnostic cannot copy
   *  arbitrary session content into a shared runtime log. */
  const forLog = (line: string): string => {
    const clean = line.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (clean.length <= LOGGED_LINE_CAP) return clean;
    let digest = 0;
    for (let i = 0; i < clean.length; i += 1) digest = (digest * 31 + clean.charCodeAt(i)) >>> 0;
    return `${clean.slice(0, LOGGED_LINE_CAP)}…(+${clean.length - LOGGED_LINE_CAP} chars, digest ${digest.toString(16)})`;
  };

  const flush = () => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };

  return {
    onData(data) {
      const text = stripAnsi(data);

      // PTY chunks are byte boundaries, not frames. A truncated line differs from the full
      // one, so comparing partials would make a static decoration look like it changes, the
      // gate would never release, and the mechanism would be inert with no signal. Only
      // COMPLETE, newline-bounded lines are ever compared.
      partial += text;
      let completeLines: string[] = [];
      let sawOnlyDecoration = true;
      const lastNewline = partial.lastIndexOf('\n');
      if (lastNewline >= 0) {
        completeLines = partial.slice(0, lastNewline).split('\n');
        partial = partial.slice(lastNewline + 1);
      }
      if (partial.length > PARTIAL_LINE_CAP) {
        // Exceeding the cap means NO COMPLETE LINE WAS OBSERVED. An over-long fragment is an
        // absence of a usable observation, not a short line — so drop it, evaluate nothing,
        // and hold the gate. Trimming and comparing what remained would reintroduce
        // truncated-line comparison through the memory bound.
        droppedFragments += 1;
        partial = '';
        options.onNotice?.(`oversized-fragment-dropped (${droppedFragments})`);
        if (completeLines.length === 0) return;
      }
      for (const line of completeLines) {
        // Non-busy lines are IGNORED, not treated as a reset: every real redraw carries many
        // of them, and resetting on those would stop the counter ever accumulating.
        if (!isBusyLine(line)) continue;
        if (line === decorationLine) { sawOnlyDecoration = sawOnlyDecoration && true; continue; }
        sawOnlyDecoration = false;
        if (lastBusyLine !== null && line === lastBusyLine) {
          staticBusyFrames += 1;
          if (busy && staticBusyFrames >= STATIC_BUSY_FRAME_LIMIT) {
            decorationLine = line;
            setBusy(false, `static-busy-line (N=${STATIC_BUSY_FRAME_LIMIT}, '${forLog(line)}')`);
            flush();
            lastBusyLine = null;
            staticBusyFrames = 0;
            return;
          }
        } else {
          lastBusyLine = line;
          staticBusyFrames = 1;
        }
      }

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
      // `sawOnlyDecoration` is false unless every busy line in this chunk is one already
      // proven static. Without the guard the release flaps: release at frame N, re-pin at N+1.
      if (!(decorationLine !== null && sawOnlyDecoration)
        && (/Working\s*\(/.test(text) || /[✱✻✽]\s+\S+/.test(text))) {
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
