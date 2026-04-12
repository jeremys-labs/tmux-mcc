import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import type { AppConfig } from '../types/config.js';
import {
  synthesizeSpeech,
  transcribeAudio,
  getVoiceStatus,
  startHealthChecks,
  stopHealthChecks,
} from '../services/voice.js';

const DEFAULT_VOICE = 'en-US-JennyNeural';

function normalizeUploadedAudioType(mimeType?: string, originalName?: string): string {
  const normalizedMime = (mimeType || '').toLowerCase();
  if (normalizedMime && normalizedMime !== 'application/octet-stream') {
    return normalizedMime;
  }

  const ext = path.extname(originalName || '').toLowerCase();
  switch (ext) {
    case '.webm':
      return 'audio/webm';
    case '.ogg':
    case '.opus':
      return 'audio/ogg';
    case '.mp4':
    case '.m4a':
      return 'audio/mp4';
    case '.aac':
      return 'audio/aac';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    default:
      return normalizedMime || 'application/octet-stream';
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

export { startHealthChecks as startVoiceHealthChecks, stopHealthChecks as stopVoiceHealthChecks };

export function createVoiceRouter(config: AppConfig): Router {
  const router = Router();

  // GET /voice/speak?text=...&agent=...
  router.get('/voice/speak', async (req: Request, res: Response) => {
    const text = req.query.text as string | undefined;
    if (!text || text.trim().length === 0) {
      res.status(400).json({ error: 'text query parameter is required' });
      return;
    }

    const agentKey = req.query.agent as string | undefined;
    let voice = DEFAULT_VOICE;
    if (agentKey && config.agents[agentKey]?.voice) {
      voice = config.agents[agentKey].voice!;
    }

    try {
      const { stream, contentType, engine } = await synthesizeSpeech(text, voice);

      res.setHeader('Content-Type', contentType);
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Voice', voice);
      res.setHeader('X-TTS-Engine', engine);

      stream.pipe(res);
      stream.on('error', (err) => {
        console.error('[Voice] TTS stream error:', err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: 'TTS stream failed' });
        }
      });
    } catch (err) {
      console.error('[Voice] TTS error:', (err as Error).message);
      res.status(500).json({ error: 'Text-to-speech failed' });
    }
  });

  // POST /voice/transcribe - multipart with audio file
  router.post('/voice/transcribe', upload.single('audio'), async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'audio file is required' });
      return;
    }

    const mimeType = normalizeUploadedAudioType(file.mimetype, file.originalname);
    const allowedTypes = new Set([
      'audio/webm',
      'audio/ogg',
      'audio/opus',
      'audio/mp4',
      'audio/x-m4a',
      'audio/aac',
      'audio/wav',
      'audio/x-wav',
      'audio/wave',
      'audio/mpeg',
    ]);

    if (!allowedTypes.has(mimeType)) {
      res.status(400).json({ error: `Unsupported audio type: ${mimeType}` });
      return;
    }

    try {
      const transcript = await transcribeAudio(file.buffer, mimeType);
      res.json({ ok: true, transcript });
    } catch (err) {
      console.error('[Voice] STT error:', (err as Error).message);
      res.status(500).json({ error: 'Transcription failed' });
    }
  });

  // GET /voice/status
  router.get('/voice/status', (_req: Request, res: Response) => {
    res.json(getVoiceStatus());
  });

  return router;
}
