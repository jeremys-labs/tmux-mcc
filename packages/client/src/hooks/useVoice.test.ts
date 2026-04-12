import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('useVoice mobile compatibility', () => {
  const file = fs.readFileSync(path.join(__dirname, 'useVoice.ts'), 'utf8');

  test('guards browser microphone APIs before recording', () => {
    expect(file).toContain("!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function'");
    expect(file).toContain("Microphone access requires HTTPS or localhost on this device/browser.");
    expect(file).toContain("typeof MediaRecorder === 'undefined'");
    expect(file).toContain("typeof MediaRecorder.isTypeSupported === 'function'");
  });

  test('includes Safari/iPhone friendly recorder mime fallbacks', () => {
    expect(file).toContain("'audio/mp4'");
    expect(file).toContain("'audio/mp4;codecs=mp4a.40.2'");
    expect(file).toContain("'audio/aac'");
  });

  test('uses actual recorder mime type when naming upload file', () => {
    expect(file).toContain("const actualMimeType = recorder.mimeType || recorderMimeTypeRef.current || 'audio/webm'");
    expect(file).toContain("const extension = actualMimeType.includes('mp4') || actualMimeType.includes('m4a')");
  });
});
