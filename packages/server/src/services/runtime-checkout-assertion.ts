/**
 * Does the checkout this monitor is RUNNING FROM match what was reviewed?
 *
 * dc-20260925-002. Founding incident, 2026-09-24 17:56: the live checkout was CLEAN, ON
 * MAIN, and WRONG — it simply had not pulled — and the monitor sent a scheduler alert into
 * Jeremy's DM 41 seconds later from pre-fix source. Nothing auto-pulls; a checkout advances
 * only when a human or an agent pulls it. So "on the default branch and clean" is NOT
 * sufficient and would have GREEN-LIT the founding condition (Isla's clause).
 *
 * WHY THIS IS NOT THE DAILY DRIFT AUDIT. `repo-drift-audit.sh` already computes OFF-TRUNK
 * (:296) and dirty (:277) — and classifies them at :414 as "CONTEXT, NOT FINDINGS", so it
 * never fails on them. It also runs once a day at 08:23 against an exposure window that was
 * TEN MINUTES wide. A daily sweep can only catch that by luck. This is a check at the POINT
 * OF USE, evaluated in the same process that is about to speak to the principal.
 *
 * WHY NOT `--is-ancestor`. It is the closest thing we have to a repository tie and it is
 * ALSO the instrument that produced the false "unmerged" claim on 2026-09-24 — it exits 1
 * after a squash and, worse, fails OPEN against a stale remote-tracking ref. A tie built on
 * it would encode that error AS the check. This compares CONTENT (`git diff --quiet`), which
 * is indifferent to squashes and rebases.
 *
 * THE FOURTH STATE IS THE POINT. A stale-but-present `origin/main` answers
 * `HEAD..origin/main = 0` plausibly FOREVER: origin advances, the fetch fails, the ref is
 * still there, and the count is still 0. Reproduced in a throwaway repo. So a failed fetch
 * must NOT collapse into `current` (a false green) and must NOT collapse into `behind`
 * (which would page someone on a network blip). It is `cannot-determine`, and it is
 * reported as itself.
 */
import { execFileSync } from 'node:child_process';

/**
 * Every git call is bounded. NEVER THROWS is not the same contract as ALWAYS RETURNS, and
 * the gap between them is where this check would have hurt most: a hung `git fetch` blocks
 * the monitor BEFORE it builds or routes the real health finding, so an unbounded probe
 * trades a wrong-source alert for no alert at all — the exact thing the module header says
 * it refuses. (Eli, review of 973d64f.)
 *
 * GIT_TERMINAL_PROMPT=0 is the other half and it is the likelier hang in practice: a fetch
 * that stops to ask for credentials waits forever on a daemon with no terminal. Same guard
 * `repo-drift-audit.sh` needed for the same reason.
 */
const DEFAULT_GIT_TIMEOUT_MS = 10_000;

export interface RealProbeOptions {
  timeoutMs?: number;
  /** Test seam only — lets a control point the probe at a deliberately hanging git. */
  gitBin?: string;
}

export type CheckoutVerdict =
  | { state: 'current' }
  | { state: 'stale'; reason: string }
  | { state: 'cannot-determine'; reason: string };

export interface CheckoutProbe {
  /** Returns stdout; throws on non-zero exit. */
  git(args: string[]): string;
}

export const realProbe = (cwd: string, options: RealProbeOptions = {}): CheckoutProbe => ({
  git: (args) =>
    execFileSync(options.gitBin ?? 'git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      // SIGTERM is what a wedged git is most likely to ignore; the bound has to be real.
      killSignal: 'SIGKILL',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' },
    }),
});

/** A timed-out subprocess is a DIFFERENT fact from a git that answered with an error. */
function timedOut(error: unknown): boolean {
  const e = error as { code?: unknown; signal?: unknown } | null;
  return !!e && (e.code === 'ETIMEDOUT' || e.signal === 'SIGKILL' || e.signal === 'SIGTERM');
}

/**
 * NEVER THROWS. A monitor that dies because it could not inspect its own checkout has
 * replaced a wrong-source alert with no alert at all, which is strictly worse: the findings
 * it was carrying are real regardless of where the code came from. Every failure path here
 * returns `cannot-determine` and the caller degrades the DESTINATION, not the run.
 */
export function assertCheckoutCurrent(
  cwd: string,
  probe: CheckoutProbe = realProbe(cwd),
): CheckoutVerdict {
  // Fetch FIRST and treat its failure as decisive. Everything below reads
  // `origin/main`, and a ref that failed to update is indistinguishable from a
  // fresh one by inspection — that is exactly the false green this exists to refuse.
  try {
    probe.git(['fetch', '--prune', '--quiet', 'origin']);
  } catch (error) {
    return {
      state: 'cannot-determine',
      reason: timedOut(error)
        ? `git fetch did not return within the time bound, so origin/main may be stale: ${errText(error)}`
        : `could not fetch origin, so origin/main may be stale: ${errText(error)}`,
    };
  }

  let branch: string;
  try {
    branch = probe.git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch (error) {
    return { state: 'cannot-determine', reason: `could not read HEAD: ${errText(error)}` };
  }
  if (branch !== 'main') {
    return { state: 'stale', reason: `checkout is on '${branch}', not main` };
  }

  let dirty: string;
  try {
    // `--untracked-files=no`: an untracked scratch file DOES NOT CHANGE THE LOADED SOURCE,
    // and the registered acceptance is dirty-in-TRACKED-source. Without this a stray
    // `opr.json` left in the shared checkout during promotion work would withhold a
    // principal alert for a reason that has nothing to do with which code is running —
    // a real shape this checkout had days ago. Staged AND unstaged tracked changes are
    // still reported; only the untracked class is excluded. (Eli, review of 973d64f.)
    dirty = probe.git(['status', '--porcelain', '--untracked-files=no']).trim();
  } catch (error) {
    return { state: 'cannot-determine', reason: `could not read status: ${errText(error)}` };
  }
  if (dirty) {
    const n = dirty.split('\n').length;
    return { state: 'stale', reason: `${n} uncommitted change(s) to tracked files in the checkout` };
  }

  // CONTENT, not ancestry. `--quiet` exits non-zero when the trees differ, which is the
  // signal; any OTHER failure mode is indistinguishable from "differs" at the exit code,
  // so the two are separated by asking git for the diff shape rather than inferring it.
  try {
    probe.git(['diff', '--quiet', 'origin/main', 'HEAD']);
  } catch {
    let detail = '';
    try {
      detail = probe.git(['diff', '--shortstat', 'origin/main', 'HEAD']).trim();
    } catch {
      return {
        state: 'cannot-determine',
        reason: 'content differs from origin/main but the difference could not be described',
      };
    }
    return { state: 'stale', reason: `content differs from origin/main: ${detail || 'unspecified'}` };
  }

  return { state: 'current' };
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
}
