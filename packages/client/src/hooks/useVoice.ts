import { useCallback, useRef } from 'react';
import { useVoiceStore } from '../stores/voiceStore';

export function useVoice() {
  const {
    activeAgent,
    isRecording,
    isPlaying,
    setActiveAgent,
    setRecording,
    setPlaying,
    setTranscribing,
    setVoiceAvailable,
    setError,
  } = useVoiceStore();

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const recorderMimeTypeRef = useRef<string>('audio/webm');

  const cleanupAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setPlaying(false);
  }, [setPlaying]);

  const checkVoiceStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/voice/status');
      if (!res.ok) throw new Error('Voice status check failed');
      await res.json(); // validate response is JSON
      // Voice is always available: Edge TTS fallback for TTS, whisper-cli fallback for STT
      setVoiceAvailable(true);
      return true;
    } catch {
      setVoiceAvailable(false);
      return false;
    }
  }, [setVoiceAvailable]);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        const secureHint = window.isSecureContext
          ? 'Microphone APIs are unavailable in this browser.'
          : 'Microphone access requires HTTPS or localhost on this device/browser.';
        throw new Error(secureHint);
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      if (typeof MediaRecorder === 'undefined') {
        throw new Error('Voice recording is not supported in this browser');
      }

      const candidateMimeTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/mp4;codecs=mp4a.40.2',
        'audio/aac',
        'audio/ogg',
      ];
      const recorderMimeType = typeof MediaRecorder.isTypeSupported === 'function'
        ? (candidateMimeTypes.find((type) => MediaRecorder.isTypeSupported(type)) || '')
        : '';

      const recorderOptions = recorderMimeType ? { mimeType: recorderMimeType } : {};
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, recorderOptions);
      } catch {
        recorder = new MediaRecorder(stream);
      }
      recorderMimeTypeRef.current = recorder.mimeType || recorderMimeType || 'audio/webm';

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorderRef.current = recorder;
      recorder.start(100); // collect chunks every 100ms
      setRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Microphone access denied');
    }
  }, [setRecording, setError]);
  const stopRecording = useCallback(async (): Promise<string | null> => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      setRecording(false);
      return null;
    }

    return new Promise((resolve) => {
      recorder.onstop = async () => {
        // Stop all mic tracks
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        setRecording(false);

        const actualMimeType = recorder.mimeType || recorderMimeTypeRef.current || 'audio/webm';
        const blob = new Blob(chunksRef.current, {
          type: actualMimeType,
        });
        chunksRef.current = [];

        if (blob.size === 0) {
          resolve(null);
          return;
        }

        setTranscribing(true);
        try {
          const extension = actualMimeType.includes('mp4') || actualMimeType.includes('m4a')
            ? 'mp4'
            : actualMimeType.includes('wav')
              ? 'wav'
              : actualMimeType.includes('aac')
                ? 'aac'
                : actualMimeType.includes('ogg')
                  ? 'ogg'
                  : 'webm';
          const form = new FormData();
          form.append('audio', blob, `recording.${extension}`);
          const res = await fetch('/api/voice/transcribe', {
            method: 'POST',
            body: form,
          });
          const data = await res.json();
          setTranscribing(false);
          if (data.ok && data.transcript) {
            resolve(data.transcript);
          } else {
            setError(data.error || 'Transcription failed');
            resolve(null);
          }
        } catch (err) {
          setTranscribing(false);
          setError(err instanceof Error ? err.message : 'Transcription request failed');
          resolve(null);
        }
      };

      recorder.stop();
    });
  }, [setRecording, setTranscribing, setError]);

  const speak = useCallback(
    async (text: string, agentKey: string) => {
      cleanupAudio();
      setError(null);

      try {
        const params = new URLSearchParams({ text, agent: agentKey });
        const res = await fetch(`/api/voice/speak?${params}`);
        if (!res.ok) throw new Error('TTS request failed');

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;

        const audio = new Audio(url);
        audioRef.current = audio;
        setPlaying(true);

        audio.onended = () => {
          cleanupAudio();
        };
        audio.onerror = () => {
          cleanupAudio();
          setError('Audio playback failed');
        };

        await audio.play();
      } catch (err) {
        cleanupAudio();
        setError(err instanceof Error ? err.message : 'TTS failed');
      }
    },
    [cleanupAudio, setPlaying, setError]
  );

  const toggleVoiceMode = useCallback(
    async (agentKey: string) => {
      if (activeAgent === agentKey) {
        // Turn off voice mode
        if (isRecording) await stopRecording();
        cleanupAudio();
        setActiveAgent(null);
      } else {
        // Turn on - check availability first
        const available = await checkVoiceStatus();
        if (available) {
          setActiveAgent(agentKey);
        } else {
          setError('Voice services not available');
        }
      }
    },
    [activeAgent, isRecording, stopRecording, cleanupAudio, setActiveAgent, checkVoiceStatus, setError]
  );

  const cleanup = useCallback(() => {
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    }
    cleanupAudio();
  }, [isRecording, cleanupAudio]);

  return {
    startRecording,
    stopRecording,
    speak,
    toggleVoiceMode,
    checkVoiceStatus,
    cleanup,
    isRecording,
    isPlaying,
  };
}
