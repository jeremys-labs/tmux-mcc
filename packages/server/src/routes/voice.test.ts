import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('voice upload compatibility', () => {
  const file = fs.readFileSync(path.join(__dirname, 'voice.ts'), 'utf8');

  test('normalizes octet-stream uploads using filename extension', () => {
    expect(file).toContain('function normalizeUploadedAudioType');
    expect(file).toContain("normalizedMime !== 'application/octet-stream'");
    expect(file).toContain("case '.m4a':");
    expect(file).toContain("return 'audio/mp4'");
  });

  test('accepts common mobile/browser audio variants', () => {
    expect(file).toContain("'audio/x-m4a'");
    expect(file).toContain("'audio/opus'");
    expect(file).toContain('allowedTypes = new Set');
  });
});
