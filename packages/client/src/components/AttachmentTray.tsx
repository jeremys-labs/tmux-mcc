// packages/client/src/components/AttachmentTray.tsx
import { X, FileText } from 'lucide-react';
import type { ChatAttachment } from '../types/attachments';

interface Props {
  attachments: ChatAttachment[];
  onRemove: (index: number) => void;
}

export function AttachmentTray({ attachments, onRemove }: Props) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2">
      {attachments.map((att, i) => (
        <div key={i} className="relative group flex items-center gap-1.5 bg-surface-overlay rounded-lg overflow-hidden border border-white/10">
          {att.previewUrl && att.mimeType.startsWith('image/') ? (
            <img
              src={att.previewUrl}
              alt={att.fileName ?? 'attachment'}
              className="w-12 h-12 object-cover"
            />
          ) : (
            <div className="w-12 h-12 flex items-center justify-center bg-surface-raised">
              <FileText className="w-5 h-5 text-text-secondary" />
            </div>
          )}
          {att.fileName && (
            <span className="text-[10px] text-text-secondary max-w-[80px] truncate pr-1">
              {att.fileName}
            </span>
          )}
          <button
            onClick={() => onRemove(i)}
            className="absolute top-0.5 right-0.5 w-4 h-4 bg-black/60 rounded-full flex items-center justify-center text-white hover:bg-red-600 transition-colors touch-manipulation"
            title="Remove"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
