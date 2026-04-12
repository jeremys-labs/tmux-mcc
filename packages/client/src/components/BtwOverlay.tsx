import { useEffect, useState } from 'react';
import { X, Zap } from 'lucide-react';
import { ChatMessage } from './ChatMessage';

interface Props {
  content: string;
  onDismiss: () => void;
}

export function BtwOverlay({ content, onDismiss }: Props) {
  const [visible, setVisible] = useState(false);

  // Fade in on mount
  useEffect(() => {
    const t = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(t);
  }, []);

  return (
    <div
      className={`mx-4 mb-2 rounded-xl border border-accent/30 bg-accent/5 transition-all duration-200 ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-1.5 px-3 pt-2 pb-1">
        <Zap className="w-3.5 h-3.5 text-accent shrink-0" />
        <span className="text-xs font-medium text-accent tracking-wide uppercase">btw</span>
        <span className="text-xs text-text-secondary ml-1">— side answer, not saved</span>
        <button
          onClick={onDismiss}
          className="ml-auto text-text-secondary hover:text-text-primary transition-colors"
          title="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Answer */}
      <div className="px-3 pb-3">
        <ChatMessage role="assistant" content={content} />
      </div>
    </div>
  );
}
