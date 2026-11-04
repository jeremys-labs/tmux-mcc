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
 *     INSTRUMENT, not merely a large file. The row cites 120 MB for `eli.log`; MEASURED
 *     2026-11-04 it is 117.0 MB, across 15 logs totalling 185.5 MB.
 *
 * The bound lives here and nowhere else, DELIBERATELY. Before this module the raw appends were
 * duplicated across EIGHT files that write this log -- and the count is worth stating precisely,
 * because I got it wrong twice: the row named ONE write site, I then said four appenders, and the
 * structural control in the test file failed on its first run and named five more. A bound added
 * at any one call site would have held or not DEPENDING ON WHICH CODE PATH HAPPENED TO LOG -- a
 * partial fix whose coverage you could not state. One writer is what makes "the file is bounded"
 * a property of the FILE rather than of the CALL SITE.
 *
 * Out of scope on isla's review, with its reason recorded so it is not mistaken for a miss:
 * `runtime-a2a-poller.ts` also appends to a `logPath`, but that path is launchd's
 * `StandardOutPath` for the poller, so routing it through a ROTATING writer would make launchd's
 * stdout follow the renamed inode and then an unlinked one. It is not a `runtime-state/<agent>.log`
 * either. It keeps its own raw append.
 */

/**
 * Rotate at this size. Env-overridable so the bound can be DEMONSTRATED by driving a log past it
 * without writing 8 MiB in a test -- a bound whose firing cannot be shown is a claim, not a guard.
 */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MIN_MAX_BYTES = 1024;

/**
 * Parse the tuning knob, falling back to the default on ANYTHING invalid.
 *
 * The first version was `Math.max(1024, Number(raw))`, and isla found the defect: a typo like
 * "8MiB" is NaN, `size >= NaN` is ALWAYS FALSE, so **a typo in the knob this PR advertises
 * silently removed the bound** -- the failure direction of a guard that cannot fire, reached by
 * misspelling it. An empty string gave 1024 and rotated on every line, which is the opposite
 * failure and just as wrong.
 *
 * So the knob must be PARSED, not coerced, and anything that is not a usable number resolves to
 * the default. A misconfigured bound degrades to the shipped one; it never degrades to none.
 */
function resolveMaxBytes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_MAX_BYTES) return DEFAULT_MAX_BYTES;
  return Math.floor(parsed);
}

export const RUNTIME_LOG_MAX_BYTES = resolveMaxBytes(process.env.RUNTIME_LOG_MAX_BYTES);

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
let rotationFailureReported = false;

function rotate(logPath: string): void {
  try {
    fs.renameSync(logPath, `${logPath}.1`);
  } catch (error) {
    // A FAILED ROTATION MUST NOT SILENCE THE LOG. The row's explicit non-goal is that the signal
    // lines keep appearing -- the FAULT and gate transitions are the only reason the 2026-09-28
    // outage was diagnosable -- so an unrotatable file is appended to anyway and grows. Losing the
    // bound is recoverable; losing the signal is what the non-goal forbids.
    //
    // BUT SWALLOWING IT ENTIRELY LOST THE BOUND WITH NO SIGNAL AT ALL (isla): a persistently
    // unrotatable file grows forever and looks exactly like one under the bound. So it reports --
    // ONCE PER PROCESS, because a line per append would be the same unbounded growth wearing a
    // diagnostic label, and because an alarm that repeats unchanged is how a real signal earns
    // the right to be ignored.
    if (!rotationFailureReported) {
      rotationFailureReported = true;
      try {
        fs.appendFileSync(logPath, `${new Date().toISOString()} rotation failed: ${String(error)}\n`);
      } catch {
        // Nothing left to try: if this append fails the next one fails too, and the caller's
        // append is the thing that must still be attempted.
      }
    }
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


/**
 * The ONE place an injection log line is built.
 *
 * WHY A FORMATTER RATHER THAN SIX CAREFUL CALL SITES. Hercule's objection is correct and sharper
 * than the limit I had written: "a source-pinned control that cannot observe the real log is
 * weaker for a DISCLOSURE property than for a behaviour one". Six sites live in wrapper modules
 * with import-time side effects, so no behaviour test in this package reaches them, and a source
 * grep proves the CURRENT TEXT rather than the property.
 *
 * Routing every site through one formatter turns the property into an exhaustion argument: a
 * reversion either goes THROUGH here, where there is no body to carry, or BYPASSES here, where the
 * source control fires. That does not depend on my having enumerated the sites correctly -- which
 * is exactly the part of my claim hercule was right to re-derive, and which I had already got
 * wrong twice (the row named one site, I then said four appenders, and there were nine).
 *
 * It is still NOT a substitute for observing the real file. Acceptance (a) says the string must be
 * absent FROM THE LOG, and a formatter's return value is not the log -- so one end-to-end
 * observation lives in the test file alongside this.
 */
// `id` is `string | number` because the sources genuinely differ -- event-inbox ids are numeric
// while mail/discord/bluebubbles ids are strings. Widening the parameter is honest; coercing at the
// one numeric call site would hide that and invite the next caller to guess.
export function formatInjectionLog(
  kind: string,
  id: string | number | undefined,
  prompt: string
): string {
  const subject = id === undefined ? kind : `${kind} ${id}`;
  return `injecting ${subject}: ${prompt.length} chars`;
}
