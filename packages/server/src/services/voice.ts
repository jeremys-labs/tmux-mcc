import http from 'http';
import { spawn } from 'child_process';
import { Readable, PassThrough } from 'stream';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// --- Configuration ---

const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  `${os.homedir()}/.cache/whisper-cpp/models/ggml-base.en.bin`;
const WHISPER_CLI = process.env.WHISPER_CLI || '/opt/homebrew/bin/whisper-cli';
const FFMPEG_BIN = process.env.FFMPEG_BIN || '/opt/homebrew/bin/ffmpeg';
const WHISPER_SERVER_URL = process.env.WHISPER_SERVER_URL || 'http://127.0.0.1:8090';
const KOKORO_URL = process.env.KOKORO_URL || 'http://127.0.0.1:8880';
const WHISPER_BEST_OF = parseInt(process.env.WHISPER_BEST_OF || '2', 10);
const WHISPER_TEMPERATURE = parseFloat(process.env.WHISPER_TEMPERATURE || '0.0');

const HEALTH_CHECK_INTERVAL_MS = 30_000;

// --- Service state ---

let whisperServerAvailable = false;
let kokoroAvailable = false;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;

// --- Health checks ---

function httpHead(urlStr: string): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL(urlStr);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        timeout: 2000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode < 500);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function checkHealth(): Promise<void> {
  const [whisper, kokoro] = await Promise.all([
    httpHead(`${WHISPER_SERVER_URL}/inference`),
    httpHead(`${KOKORO_URL}/v1/audio/speech`),
  ]);

  if (whisper !== whisperServerAvailable) {
    console.log(`[Voice] Whisper server: ${whisper ? 'available' : 'unavailable'}`);
  }
  if (kokoro !== kokoroAvailable) {
    console.log(`[Voice] Kokoro TTS: ${kokoro ? 'available' : 'unavailable'}`);
  }

  whisperServerAvailable = whisper;
  kokoroAvailable = kokoro;
}

export function startHealthChecks(): void {
  // Run immediately, then on interval
  void checkHealth();
  healthCheckTimer = setInterval(() => void checkHealth(), HEALTH_CHECK_INTERVAL_MS);
}

export function stopHealthChecks(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

export function getVoiceStatus(): {
  whisperServer: boolean;
  kokoro: boolean;
  edgeTts: boolean;
  sttAvailable: boolean;
  ttsAvailable: boolean;
} {
  return {
    whisperServer: whisperServerAvailable,
    kokoro: kokoroAvailable,
    edgeTts: true, // Edge TTS is always available (no local server needed)
    sttAvailable: true, // whisper-cli fallback always available
    ttsAvailable: true, // kokoro or Edge TTS fallback always available
  };
}

// --- TTS ---

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function synthesizeWithKokoro(
  text: string,
  _voice: string,
): Promise<{ stream: Readable; contentType: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'kokoro',
      input: text,
      voice: 'af_heart',
      response_format: 'wav',
    });

    const url = new URL(`${KOKORO_URL}/v1/audio/speech`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Kokoro returned ${res.statusCode}`));
          return;
        }
        resolve({ stream: res, contentType: 'audio/wav' });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Kokoro request timeout'));
    });
    req.write(body);
    req.end();
  });
}

async function synthesizeWithEdgeTTS(
  text: string,
  voice: string,
): Promise<{ stream: Readable; contentType: string }> {
  // Dynamic import since node-edge-tts is ESM
  const { EdgeTTS } = await import('node-edge-tts');

  const tts = new EdgeTTS({
    voice,
    lang: 'en-US',
    outputFormat: 'audio-24khz-96kbitrate-mono-mp3',
  });

  const safeText = escapeXml(text);
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US"><voice name="${voice}"><prosody rate="default" pitch="default" volume="default">${safeText}</prosody></voice></speak>`;

  const passthrough = new PassThrough();

  // Use node-edge-tts streaming API
  const ws = await tts._connectWebSocket();

  ws.on('message', (data: Buffer | string, isBinary: boolean) => {
    if (isBinary) {
      // Binary frame - extract audio after Path:audio separator
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const separator = 'Path:audio\r\n';
      const separatorBuf = Buffer.from(separator);
      const index = buf.indexOf(separatorBuf);
      if (index === -1) return;

      const audioData = buf.subarray(index + separatorBuf.length);
      if (audioData.length > 0) {
        passthrough.write(audioData);
      }
    } else {
      // Text frame - check for turn.end
      const message = typeof data === 'string' ? data : data.toString();
      if (message.includes('Path:turn.end')) {
        passthrough.end();
      }
    }
  });

  ws.on('close', () => {
    if (!passthrough.destroyed) passthrough.end();
  });

  ws.on('error', (err: Error) => {
    if (!passthrough.destroyed) passthrough.destroy(err);
  });

  // Send SSML
  const requestId = crypto.randomUUID().replace(/-/g, '');
  const configMsg =
    `X-RequestId:${requestId}\r\n` +
    `Content-Type:application/ssml+xml\r\n` +
    `Path:ssml\r\n\r\n` +
    ssml;
  ws.send(configMsg);

  return { stream: passthrough, contentType: 'audio/mpeg' };
}

export async function synthesizeSpeech(
  text: string,
  voice: string,
): Promise<{ stream: Readable; contentType: string; engine: string }> {
  // Try Kokoro first if available
  if (kokoroAvailable) {
    try {
      const result = await synthesizeWithKokoro(text, voice);
      return { ...result, engine: 'kokoro' };
    } catch (err) {
      console.warn('[Voice] Kokoro TTS failed, falling back to Edge TTS:', (err as Error).message);
    }
  }

  // Fall back to Edge TTS
  const result = await synthesizeWithEdgeTTS(text, voice);
  return { ...result, engine: 'edge-tts' };
}

// --- STT ---

function correctTranscript(raw: string): string {
  let text = raw.trim();

  // Collapse repeated words: "the the the" -> "the"
  text = text.replace(/\b(\w+)(\s+\1){1,5}\b/gi, '$1');

  // Collapse repeated short phrases (2-4 words)
  text = text.replace(/\b((?:\w+\s+){1,3}\w+)(\s+\1){1,3}\b/gi, '$1');

  return text.trim();
}

function transcribeWithWhisperServer(audioBuffer: Buffer, mimeType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const boundary = `----FormBoundary${crypto.randomUUID().replace(/-/g, '')}`;
    const ext = mimeType.includes('wav')
      ? 'wav'
      : mimeType.includes('ogg')
        ? 'ogg'
        : mimeType.includes('webm')
          ? 'webm'
          : 'mp4';
    const filename = `audio.${ext}`;

    const parts: Buffer[] = [];

    // file field
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
      ),
    );
    parts.push(audioBuffer);
    parts.push(Buffer.from('\r\n'));

    // temperature field
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="temperature"\r\n\r\n${WHISPER_TEMPERATURE}\r\n`,
      ),
    );

    // best_of field
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="best_of"\r\n\r\n${WHISPER_BEST_OF}\r\n`,
      ),
    );

    // response_format field
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`,
      ),
    );

    // End boundary
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const url = new URL(`${WHISPER_SERVER_URL}/inference`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
        timeout: 30000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Whisper server returned ${res.statusCode}`));
            return;
          }
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { text?: string };
            resolve(json.text || '');
          } catch (e) {
            reject(new Error(`Failed to parse whisper-server response: ${(e as Error).message}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Whisper server request timeout'));
    });
    req.write(body);
    req.end();
  });
}

function transcribeWithWhisperCli(audioBuffer: Buffer, mimeType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const inputFile = path.join(tmpDir, `voice-${crypto.randomUUID()}.input`);
    const wavFile = path.join(tmpDir, `voice-${crypto.randomUUID()}.wav`);

    // Determine extension from mime
    const ext = mimeType.includes('wav')
      ? 'wav'
      : mimeType.includes('ogg')
        ? 'ogg'
        : mimeType.includes('webm')
          ? 'webm'
          : 'mp4';
    const inputPath = `${inputFile}.${ext}`;

    fs.writeFileSync(inputPath, audioBuffer);

    // Convert to WAV 16kHz mono with ffmpeg
    const ffmpeg = spawn(FFMPEG_BIN, [
      '-y',
      '-i',
      inputPath,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-f',
      'wav',
      wavFile,
    ]);

    ffmpeg.on('error', (err) => {
      cleanup();
      reject(new Error(`ffmpeg failed: ${err.message}`));
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        cleanup();
        reject(new Error(`ffmpeg exited with code ${code}`));
        return;
      }

      // Run whisper-cli
      const whisper = spawn(WHISPER_CLI, [
        '-m',
        WHISPER_MODEL,
        '--no-prints',
        '-f',
        wavFile,
      ]);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      whisper.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      whisper.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      whisper.on('error', (err) => {
        cleanup();
        reject(new Error(`whisper-cli failed: ${err.message}`));
      });

      whisper.on('close', (wcode) => {
        cleanup();
        if (wcode !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString();
          reject(new Error(`whisper-cli exited with code ${wcode}: ${stderr}`));
          return;
        }

        let transcript = Buffer.concat(stdoutChunks).toString('utf-8');
        // Strip timestamp brackets like [00:00:00.000 --> 00:00:05.000]
        transcript = transcript.replace(/\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/g, '');
        resolve(transcript.trim());
      });
    });

    function cleanup(): void {
      try {
        fs.unlinkSync(inputPath);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(wavFile);
      } catch {
        /* ignore */
      }
    }
  });
}

export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string = 'audio/webm',
): Promise<string> {
  let raw: string;

  // Try whisper-server first
  if (whisperServerAvailable) {
    try {
      raw = await transcribeWithWhisperServer(audioBuffer, mimeType);
      return correctTranscript(raw);
    } catch (err) {
      console.warn(
        '[Voice] Whisper server transcription failed, falling back to CLI:',
        (err as Error).message,
      );
    }
  }

  // Fall back to whisper-cli
  raw = await transcribeWithWhisperCli(audioBuffer, mimeType);
  return correctTranscript(raw);
}
