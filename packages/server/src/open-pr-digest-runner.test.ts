import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-pr-digest-runner-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('run-open-pr-digest', () => {
  it('writes fail status for a partial sweep failure while preserving dry-run delivery', () => {
    const root = tempDir();
    const fakeDigest = path.join(root, 'fake-digest.mjs');
    const statusPath = path.join(root, 'status.json');
    fs.writeFileSync(fakeDigest, 'console.log("partial digest"); process.exit(1);');

    const here = path.dirname(fileURLToPath(import.meta.url));
    const runner = path.resolve(here, '../../../scripts/run-open-pr-digest.mjs');
    const result = spawnSync('node', [runner, '--dry-run'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        OPEN_PR_DIGEST_SCRIPT: fakeDigest,
        OPEN_PR_DIGEST_STATUS_PATH: statusPath,
        OPEN_PR_DIGEST_CHAT_ID: 'dev-channel',
        OPEN_PR_DIGEST_AGENT: 'marcus',
        OPEN_PR_DIGEST_JOB_ID: 'open-pr-digest-daily',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('dry-run: would deliver');
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    expect(status.status).toBe('fail');
    expect(status.reason).toBe('partial_failure');
    expect(status.deliveryOk).toBe(true);
    expect(status.sweepExitCode).toBe(1);
    expect(status.dryRun).toBe(true);
  });
});
