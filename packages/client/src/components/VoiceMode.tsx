import { useEffect, useRef, useState, useCallback } from 'react';
import { useVoice } from '../hooks/useVoice';
import { useVoiceStore } from '../stores/voiceStore';

interface Props {
  agentKey: string;
  onTranscript: (text: string) => void;
}

export function VoiceMode({ agentKey, onTranscript }: Props) {
  const { startRecording, stopRecording, toggleVoiceMode, cleanup } = useVoice();
  const activeAgent = useVoiceStore((s) => s.activeAgent);
  const isRecording = useVoiceStore((s) => s.isRecording);
  const isPlaying = useVoiceStore((s) => s.isPlaying);
  const isTranscribing = useVoiceStore((s) => s.isTranscribing);
  const error = useVoiceStore((s) => s.error);
  const setError = useVoiceStore((s) => s.setError);

  const [recordingTime, setRecordingTime] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isActive = activeAgent === agentKey;

  // Recording timer
  useEffect(() => {
    if (isRecording) {
      setRecordingTime(0);
      timerRef.current = setInterval(() => setRecordingTime((t) => t + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      setRecordingTime(0);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRecording]);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  // Clear error after 4 seconds
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error, setError]);

  const handleRecordStart = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault();
      if (!isActive || isTranscribing || isPlaying) return;
      startRecording();
    },
    [isActive, isTranscribing, isPlaying, startRecording]
  );

  const handleRecordEnd = useCallback(
    async (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault();
      if (!isRecording) return;
      const transcript = await stopRecording();
      if (transcript && transcript.trim()) {
        onTranscript(transcript.trim());
      }
    },
    [isRecording, stopRecording, onTranscript]
  );

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Determine button visual state
  const buttonClasses = isRecording
    ? 'bg-red-500 animate-pulse shadow-lg shadow-red-500/40'
    : isTranscribing
      ? 'bg-yellow-500'
      : isPlaying
        ? 'bg-blue-500'
        : isActive
          ? 'bg-surface-overlay hover:bg-accent/60'
          : 'bg-surface-overlay hover:bg-surface-overlay/80';

  const statusText = isRecording
    ? `Recording ${formatTime(recordingTime)}`
    : isTranscribing
      ? 'Transcribing...'
      : isPlaying
        ? 'Speaking...'
        : isActive
          ? 'Hold to talk'
          : '';

  return (
    <div className="flex items-center gap-3 px-3 py-2">
      {/* Voice mode toggle */}
      <button
        onClick={() => toggleVoiceMode(agentKey)}
        className={`text-xs px-2 py-1 rounded-md transition-colors ${
          isActive
            ? 'bg-accent text-white'
            : 'bg-surface-overlay text-text-secondary hover:text-text-primary'
        }`}
        title={isActive ? 'Disable voice mode' : 'Enable voice mode'}
      >
        {isActive ? 'Voice ON' : 'Voice'}
      </button>

      {isActive && (
        <>
          {/* Push-to-talk button */}
          <button
            onMouseDown={handleRecordStart}
            onMouseUp={handleRecordEnd}
            onMouseLeave={handleRecordEnd}
            onTouchStart={handleRecordStart}
            onTouchEnd={handleRecordEnd}
            disabled={isTranscribing || isPlaying}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${buttonClasses} disabled:opacity-50`}
            title="Hold to record"
          >
            {/* Microphone icon */}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="w-5 h-5 text-text-primary"
            >
              <path d="M12 14a3 3 0 003-3V5a3 3 0 00-6 0v6a3 3 0 003 3z" />
              <path d="M19 11a1 1 0 10-2 0 5 5 0 01-10 0 1 1 0 10-2 0 7 7 0 006 6.93V21H8a1 1 0 100 2h8a1 1 0 100-2h-3v-3.07A7 7 0 0019 11z" />
            </svg>
          </button>

          {/* Status text */}
          <span className="text-xs text-text-secondary min-w-[100px]">
            {statusText}
          </span>
        </>
      )}

      {/* Error display */}
      {error && (
        <span className="text-xs text-red-400 ml-auto">{error}</span>
      )}
    </div>
  );
}
