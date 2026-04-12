import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ensureContentDirs, getContentPath } from './content.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('content directory', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-content-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('creates required subdirectories', () => {
    ensureContentDirs(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, 'data'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'files', 'inbox'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'files', 'approved'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'files', 'archive'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'databases'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'memory', 'agents'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'assets'))).toBe(true);
  });

  it('resolves paths relative to content root', () => {
    ensureContentDirs(tmpDir);
    expect(getContentPath(tmpDir, 'data', 'standup.json'))
      .toBe(path.join(tmpDir, 'data', 'standup.json'));
  });
});
