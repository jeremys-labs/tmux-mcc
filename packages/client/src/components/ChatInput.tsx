import { useRef, useCallback, useEffect, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { AttachmentTray } from './AttachmentTray';
import type { ChatAttachment } from '../types/attachments';

const MAX_TOTAL_BYTES = 4.5 * 1024 * 1024; // 4.5MB — conservative under gateway's 5MB

interface Props {
  value: string;
  onChange: (text: string) => void;
  onSend: (text: string, attachments: ChatAttachment[]) => void;
  onBtw?: (question: string) => void;
  onInterrupt?: () => void;
  isStreaming: boolean;
  placeholder?: string;
}

function readFileAsBase64(file: File): Promise<{ content: string; previewUrl?: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result is a data URI like "data:image/png;base64,<data>"
      const base64 = result.split(',')[1];
      const previewUrl = file.type.startsWith('image/') ? result : undefined;
      resolve({ content: base64, previewUrl });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function filesToAttachments(files: FileList | File[]): Promise<ChatAttachment[]> {
  const list = Array.from(files);
  return Promise.all(
    list.map(async (file) => {
      const { content, previewUrl } = await readFileAsBase64(file);
      return {
        mimeType: file.type || 'application/octet-stream',
        fileName: file.name,
        type: file.type.startsWith('image/') ? 'image' : 'file',
        content,
        previewUrl,
        sizeBytes: file.size,
      } satisfies ChatAttachment;
    })
  );
}

export function ChatInput({ value, onChange, onSend, onBtw, onInterrupt, isStreaming, placeholder }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [sizeError, setSizeError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
  }, [value]);

  // Scroll into view on mobile keyboard open
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const handleFocus = () => {
      setTimeout(() => {
        containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }, 300);
    };
    textarea.addEventListener('focus', handleFocus);
    return () => textarea.removeEventListener('focus', handleFocus);
  }, []);

  const totalBytes = attachments.reduce((sum, a) => sum + a.sizeBytes, 0);
  const overLimit = totalBytes > MAX_TOTAL_BYTES;

  const addAttachments = useCallback(async (files: FileList | File[]) => {
    try {
      const newAtts = await filesToAttachments(files);
      setAttachments((prev) => {
        const merged = [...prev, ...newAtts];
        const total = merged.reduce((s, a) => s + a.sizeBytes, 0);
        if (total > MAX_TOTAL_BYTES) {
          setSizeError(`Total size ${(total / 1024 / 1024).toFixed(1)}MB exceeds 4.5MB limit`);
        } else {
          setSizeError(null);
        }
        return merged;
      });
    } catch (err) {
      console.error('Failed to read file:', err);
    }
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => {
      const next = prev.filter((_, i) => i !== index);
      const total = next.reduce((s, a) => s + a.sizeBytes, 0);
      if (total <= MAX_TOTAL_BYTES) setSizeError(null);
      return next;
    });
  }, []);

  const doSend = useCallback(() => {
    if (overLimit) return;
    const text = value.trim();
    if (!text && attachments.length === 0) return;

    // /btw prefix: route to side question, don't add to chat history
    const btwMatch = text.match(/^\/btw\s+(.+)/si);
    if (btwMatch && onBtw) {
      onBtw(btwMatch[1].trim());
      onChange('');
      setAttachments([]);
      setSizeError(null);
      return;
    }

    onSend(text, attachments);
    setAttachments([]);
    setSizeError(null);
    textareaRef.current?.blur();
  }, [value, attachments, overLimit, onSend, onBtw, onChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
        e.preventDefault();
        // Enter always sends — use the Stop button to interrupt
        doSend();
      }
    },
    [doSend]
  );

  // Drag and drop
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      addAttachments(e.dataTransfer.files);
    }
  }, [addAttachments]);

  const isBtw = /^\/btw\s/i.test(value);
  const canSend = !overLimit && (value.trim().length > 0 || attachments.length > 0);

  return (
    <div
      ref={containerRef}
      className={`relative border-t border-white/10 bg-surface-raised transition-colors ${isDragOver ? 'bg-accent/10 border-accent' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay hint */}
      {isDragOver && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <div className="text-accent text-sm font-medium bg-surface-raised/90 px-4 py-2 rounded-lg border border-accent">
            Drop files to attach
          </div>
        </div>
      )}

      {/* Attachment tray */}
      <AttachmentTray attachments={attachments} onRemove={removeAttachment} />

      {/* Size error */}
      {sizeError && (
        <div className="px-3 pt-1 text-xs text-red-400">{sizeError}</div>
      )}

      {/* Input row */}
      <div className="flex gap-2 items-end p-3">
        {/* Attach button */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="text-text-secondary hover:text-text-primary active:text-accent transition-colors shrink-0 mb-0.5 touch-manipulation"
          title="Attach files"
        >
          <Paperclip className="w-5 h-5" />
        </button>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,application/pdf,.txt,.md,.csv,.json,.log"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addAttachments(e.target.files);
            e.target.value = '';
          }}
        />

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isDragOver ? 'Drop files here…' : (placeholder || 'Type a message...')}
          rows={1}
          enterKeyHint="send"
          className="flex-1 bg-surface-overlay text-text-primary rounded-lg px-3 py-2 resize-none text-sm focus:outline-none focus:ring-1 focus:ring-accent"
        />

        {/* Stop button — only active while streaming */}
        <button
          onClick={() => onInterrupt?.()}
          disabled={!isStreaming}
          title="Stop response"
          className={`px-3 py-2 rounded-lg text-sm font-medium shrink-0 transition-colors ${
            isStreaming
              ? 'bg-red-600 hover:bg-red-700 text-white'
              : 'bg-red-600/20 text-red-400/40 cursor-not-allowed'
          }`}
        >
          Stop
        </button>

        {/* Send button — always active when there's content */}
        <button
          onClick={doSend}
          disabled={!canSend}
          title={isBtw ? 'Ask side question (/btw)' : 'Send message'}
          className={`px-4 py-2 rounded-lg text-sm font-medium shrink-0 transition-colors ${
            canSend
              ? isBtw
                ? 'bg-accent/70 hover:bg-accent text-white'
                : 'bg-accent hover:bg-accent/80 text-white'
              : 'bg-accent/40 text-white/50 cursor-not-allowed'
          }`}
        >
          {isBtw ? 'Ask' : 'Send'}
        </button>
      </div>
    </div>
  );
}
