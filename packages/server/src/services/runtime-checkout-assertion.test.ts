import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { assertCheckoutCurrent, realProbe, type CheckoutProbe } from './runtime-checkout-assertion.js';

/** A scripted git. Each entry is matched on the first two argv tokens. */
function probeOf(script: Record<string, string | Error>): CheckoutProbe {
  return {
    git: (args) => {
      const key = args.slice(0, 2).join(' ');
      const hit = script[key];
      if (hit === undefined) throw new Error(`unscripted git call: ${args.join(' ')}`);
      if (hit instanceof Error) throw hit;
      return hit;
    },
  };
}

const CLEAN = {
  'fetch --prune': '',
  'rev-parse --abbrev-ref': 'main\n',
  'status --porcelain': '',
  'diff --quiet': '',
};

describe('assertCheckoutCurrent', () => {
  it('reports current only when fetched, on main, clean, and content-identical', () => {
    expect(assertCheckoutCurrent('/x', probeOf(CLEAN))).toEqual({ state: 'current' });
  });

  // THE FOUNDING CONDITION, 2026-09-24 17:56. The checkout was CLEAN and ON MAIN and the
  // monitor still sent pre-fix source into Jeremy's DM, because it had not pulled. An
  // assertion of "on main and clean" ALONE would have returned current here and green-lit
  // exactly the incident this row exists for.
  it('is STALE when on main and clean but the content differs from origin/main', () => {
    const verdict = assertCheckoutCurrent('/x', probeOf({
      ...CLEAN,
      'diff --quiet': new Error('exit 1'),
      'diff --shortstat': ' 2 files changed, 8 insertions(+)\n',
    }));
    expect(verdict.state).toBe('stale');
    expect(verdict).toHaveProperty('reason', expect.stringContaining('2 files changed'));
  });

  // THE FOURTH STATE. A stale-but-present origin/main answers every later question
  // plausibly, so a failed fetch must not collapse into `current` (false green) nor into
  // `stale` (paging someone on a network blip). Reported as itself.
  it('is CANNOT-DETERMINE when the fetch fails, never current and never stale', () => {
    const verdict = assertCheckoutCurrent('/x', probeOf({
      ...CLEAN,
      'fetch --prune': new Error('fatal: unable to access origin: Could not resolve host'),
    }));
    expect(verdict.state).toBe('cannot-determine');
    expect(verdict).toHaveProperty('reason', expect.stringContaining('may be stale'));
  });

  it('is STALE off-trunk and STALE when dirty', () => {
    expect(assertCheckoutCurrent('/x', probeOf({
      ...CLEAN, 'rev-parse --abbrev-ref': 'marcus/wip\n',
    })).state).toBe('stale');
    expect(assertCheckoutCurrent('/x', probeOf({
      ...CLEAN, 'status --porcelain': ' M packages/server/src/a.ts\n?? b.ts\n',
    })).state).toBe('stale');
  });

  // NEVER THROWS: a monitor that dies inspecting its own checkout has replaced a
  // wrong-source alert with NO alert, and the findings it carried were real either way.
  it('never throws — every git failure becomes cannot-determine', () => {
    for (const failing of ['rev-parse --abbrev-ref', 'status --porcelain']) {
      const verdict = assertCheckoutCurrent('/x', probeOf({ ...CLEAN, [failing]: new Error('boom') }));
      expect(verdict.state).toBe('cannot-determine');
    }
    expect(assertCheckoutCurrent('/x', { git: () => { throw new Error('git missing'); } }).state)
      .toBe('cannot-determine');
  });

  describe('bounded probe and tracked-only dirtiness (Eli, review of 973d64f)', () => {
    it('classifies a timed-out git as cannot-determine, naming the time bound', () => {
      const killed = Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
      const verdict = assertCheckoutCurrent('/x', probeOf({ 'fetch --prune': killed }));
      expect(verdict.state).toBe('cannot-determine');
      expect((verdict as { reason: string }).reason).toContain('did not return within the time bound');
      // Must NOT read as a plain fetch failure, and must never read as current or stale.
      expect((verdict as { reason: string }).reason).not.toContain('could not fetch origin,');
    });

    it('CONTROL: the REAL probe returns rather than hanging when git never exits', () => {
      // The injected-probe tests above prove CLASSIFICATION. This one proves the BOUND:
      // a scripted probe can never demonstrate that execFileSync is actually bounded.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hanging-git-'));
      const fakeGit = path.join(dir, 'git');
      fs.writeFileSync(fakeGit, '#!/bin/sh\nsleep 30\n');
      fs.chmodSync(fakeGit, 0o755);

      const started = Date.now();
      const verdict = assertCheckoutCurrent(dir, realProbe(dir, { gitBin: fakeGit, timeoutMs: 300 }));
      const elapsed = Date.now() - started;

      expect(verdict.state).toBe('cannot-determine');
      // Returned on the bound, not on the sleep. Generous ceiling so this cannot flake.
      expect(elapsed).toBeLessThan(5_000);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('asks git to exclude untracked files, so the flag cannot be dropped silently', () => {
      const seen: string[][] = [];
      const probe: CheckoutProbe = {
        git: (args) => {
          seen.push(args);
          if (args[0] === 'rev-parse') return 'main\n';
          return '';
        },
      };
      assertCheckoutCurrent('/x', probe);
      const status = seen.find((a) => a[0] === 'status');
      expect(status).toBeDefined();
      expect(status).toContain('--untracked-files=no');
    });

    it('flags an UNSTAGED tracked modification as stale', () => {
      const verdict = assertCheckoutCurrent('/x', probeOf({ ...CLEAN, 'status --porcelain': ' M src/a.ts\n' }));
      expect(verdict.state).toBe('stale');
      expect((verdict as { reason: string }).reason).toContain('tracked');
    });

    it('flags a STAGED tracked modification as stale', () => {
      const verdict = assertCheckoutCurrent('/x', probeOf({ ...CLEAN, 'status --porcelain': 'M  src/a.ts\n' }));
      expect(verdict.state).toBe('stale');
      expect((verdict as { reason: string }).reason).toContain('tracked');
    });

    it('CONTROL: real git proves --untracked-files=no hides untracked but not tracked edits', () => {
      // The scripted tests above assert what we DO with git's answer. This asserts that
      // git's answer is what I claim it is, rather than assuming the flag's semantics.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untracked-git-'));
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      git('init', '--quiet');
      git('config', 'user.email', 't@t');
      git('config', 'user.name', 't');
      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'a\n');
      git('add', 'tracked.txt');
      git('commit', '--quiet', '-m', 'x');

      fs.writeFileSync(path.join(dir, 'scratch.json'), '{}\n'); // the opr.json shape
      expect(git('status', '--porcelain', '--untracked-files=no').trim()).toBe('');
      expect(git('status', '--porcelain').trim()).not.toBe(''); // and the old form WOULD have flagged it

      fs.writeFileSync(path.join(dir, 'tracked.txt'), 'b\n');
      expect(git('status', '--porcelain', '--untracked-files=no').trim()).not.toBe('');
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
