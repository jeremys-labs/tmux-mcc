# Codex readiness gate bounded reproduction — 2026-09-04

Status: reproduction complete; parser repair intentionally not attempted.

## Result

The observed mechanism disproves the narrow callback-fragmentation hypothesis. Codex v0.151.0 emitted the completed response and final visible input prompt together in callback 894. The prompt was cursor-addressed rather than newline-delimited:

```text
ESC [23;1H ESC [1m › ESC [22m SPACE Ask Codex to do anything
```

The current parser strips CSI sequences but does not apply their terminal semantics. After stripping, the prompt glyph is preceded by other flattened text/spaces. Neither current predicate matches:

```text
text.includes('\n› ')
text.startsWith('› ')
```

The state trace is therefore:

```text
callback 808  idle -> busy  marker=working
callback 894  no transition (visible prompt present, parser misses it)
end           busy; waitForIdle() unresolved
```

An independently captured tmux pane visibly showed `› Ask Codex to do anything` after the response marker while the replayed gate remained busy.

## Evidence

- `packages/server/src/services/__fixtures__/codex-readiness-v0.151.0-final-prompt.json`
  - 899 original `node-pty` `onData` callbacks
  - 142,949 bytes
  - original callback sequence and boundaries preserved
  - each callback stores elapsed nanoseconds, byte length, SHA-256, and base64 bytes
  - the workspace-root literal was reduced across the concatenated byte stream using equal-byte `0x78` replacement, then split back at the original boundaries; five replacements were made
  - original and sanitized whole-stream hashes are embedded in the fixture
- `packages/server/src/services/__fixtures__/codex-readiness-v0.151.0-final-screen.txt`
  - human-readable tmux rendering captured while the child Codex TUI was still alive
- `packages/server/src/services/runtime-codex-readiness.repro.test.ts`
  - replays the captured callbacks through the unmodified production gate
  - verifies every stored chunk length/hash before replay

## RED regression and controls

Command:

```bash
node_modules/.bin/vitest run packages/server/src/services/runtime-codex-readiness.repro.test.ts --reporter=verbose
```

Observed result against `main` at `419745a`:

```text
1 failed | 2 passed

FAIL  RED: releases waitForIdle after the final prompt is visibly rendered
Expected: idle
Received: still-busy

PASS  keeps queued-input busy when a prompt appears earlier in the same callback
PASS  keeps later working evidence busy when a prompt appears earlier in the same callback
```

The two controls are separate so a future repair cannot make prompt detection win prematurely over queued-input or later-working evidence from the same complete callback.

## Capture procedure

The capture harness is `packages/server/scripts/capture-codex-readiness-repro.mjs`. It runs a controlled, read-only Codex turn under `node-pty`, records each callback before writing the same bytes to stdout, and uses a bounded submission timer so driving the turn does not depend on the detector under test. The harness remained alive after signaling completion so tmux could capture the rendered final screen.

Sanitization is performed by `packages/server/scripts/sanitize-codex-readiness-capture.mjs`. Replacement is byte-length preserving and happens before the stream is divided back into the recorded callback boundaries.

## Scope and safety

- No production parser code changed.
- No fallback timing, retry budget, wrapper behavior, or live runtime changed.
- The live checkout remained clean `main` at `419745a` throughout.
- This branch is evidence-only and intentionally RED; it must not be merged as a repair.
