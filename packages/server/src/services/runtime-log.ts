import fs from 'fs';

/**
 * The ONE writer for the shared runtime log at `<content>/bridge/runtime-state/<agent>.log`.
 *
 * WHY THIS MODULE EXISTS (dc-20261001-002). Two problems, and only the first is obvious:
 *
 *  1. The log recorded FULL PROMPT BODIES, while its sibling `runtime-injection-journal.ts`
 *     deliberately records `promptLength` only, with the comment "char count only -- never raw
 *     text (injected prompts may carry sensitive content)". One artifact was designed to avoid
 *     exactly what the other did, into a path shared across the fleet.
 *
 *  2. THE SECOND-ORDER EFFECT IS WHAT MAKES IT MORE THAN A SIZE PROBLEM, and it has already been
 *     paid for: because full bodies were in the log, grepping the log for its own SIGNAL lines
 *     matched PROSE INSIDE QUOTED MAIL. On 2026-10-01 that cost two false readings -- four
 *     apparent `oversized-fragment-dropped` hits were all design text quoted back inside an
 *     injected prompt. A log that cannot be grepped for its own signal lines is a DEGRADED
 *     INSTRUMENT, not merely a large file. `eli.log` had reached 120 MB.
 *
 * The bound lives here and nowhere else, DELIBERATELY. Before this module the raw appends were
 * duplicated across four files (`claude-wrapper`, `codex-wrapper`, `runtime-agent-mail`,
 * `runtime-events`), so a bound added at any one of them would have held or not depending on
 * which code path happened to log -- a partial fix whose coverage you could not state. One writer
 * is what makes "the file is bounded" a property of the file rather than of the call site.
 */

/**
 * Rotate at this size. Env-overridable so the bound can be DEMONSTRATED by driving a log past it
 * without writing 8 MiB in a test -- a bound whose firing cannot be shown is a claim, not a guard.
 */
export const RUNTIME_LOG_MAX_BYTES = Math.max(
  1024,
  Number(process.env.RUNTIME_LOG_MAX_BYTES ?? String(8 * 1024 * 1024))
);

function sizeOf(logPath: string): number {
  try {
    return fs.statSync(logPath).size;
  } catch {
    // Missing file is size 0, not an error: the first append creates it.
    return 0;
  }
}

/**
 * Keep ONE previous generation, so total on-disk use is bounded by 2 x RUNTIME_LOG_MAX_BYTES.
 *
 * One generation rather than none because the rotation must not destroy the evidence the log
 * exists for: an incident diagnosed from `.log` alone would otherwise lose everything older than
 * the last rotation at the moment it rotates. One rather than many because a generation count is
 * a retention policy nobody asked for, and the row asked for a bound.
 */
function rotate(logPath: string): void {
  try {
    fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    // A FAILED ROTATION MUST NOT SILENCE THE LOG. The row's explicit non-goal is that the signal
    // lines keep appearing -- the FAULT and gate transitions are the only reason the 2026-09-28
    // outage was diagnosable -- so an unrotatable file is appended to anyway and grows. Losing the
    // bound is recoverable; losing the signal is what the non-goal forbids.
  }
}

/**
 * Append one line, timestamped, rotating first if the file has reached the bound.
 *
 * The caller passes the MESSAGE, never a pre-formatted line: the timestamp belongs to the writer
 * so every line in the file has the same shape, which is what makes the log greppable by prefix.
 *
 * The size check is a `stat` per line. That is deliberate and affordable here -- these are
 * injection- and event-rate writes, not a hot loop -- and the alternative (caching the size in
 * memory) is wrong for this file, because several PROCESSES append to one agent's log and a cached
 * size would drift from the file the moment another writer rotated it.
 */
export function appendRuntimeLogLine(logPath: string, message: string): void {
  if (sizeOf(logPath) >= RUNTIME_LOG_MAX_BYTES) {
    rotate(logPath);
  }
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
}
