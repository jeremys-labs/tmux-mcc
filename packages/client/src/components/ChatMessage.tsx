import { memo, useState, useCallback, useEffect } from 'react';
import { Copy, Check } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatRelativeTime, formatPreciseTime } from '../utils/formatTime';

/**
 * LLMs occasionally produce malformed GFM tables. Two known failure modes:
 *
 * 1. All rows collapsed onto one line (no newlines between rows).
 *    remark-gfm requires each row on its own line.
 *
 * 2. Separator row column count doesn't match the header.
 *    e.g. header has 3 cols but separator is |---|---| (2 cols).
 *    remark-gfm rejects the table and renders it as plain text.
 *
 * This function fixes both before handing content to ReactMarkdown.
 * Already-correct tables and prose containing pipes are unaffected.
 */
function normalizeMarkdownTables(content: string): string {
  // Step 1: expand single-line collapsed tables onto separate lines
  let result = content.replace(
    /(\|[^\n]+\|)\s+(\|[-| :]+\|)\s+(\|[^\n]+(?:\s+\|[^\n]+\|)*)/g,
    (match) => match.split(/(?<=\|)\s+(?=\|)/).join('\n')
  );

  // Step 2: fix separator rows whose column count doesn't match their header
  result = result.replace(
    /^(\|.+\|)\n(\|[-| :]+\|)$/gm,
    (match, headerRow: string, sepRow: string) => {
      const headerCols = (headerRow.match(/\|/g) ?? []).length - 1;
      const sepCols = (sepRow.match(/\|/g) ?? []).length - 1;
      if (headerCols === sepCols) return match; // already correct
      // Rebuild separator with the right number of columns
      const newSep = '|' + Array(headerCols).fill('---').join('|') + '|';
      return `${headerRow}\n${newSep}`;
    }
  );

  return result;
}

/**
 * Strip common markdown syntax to produce clean plain text for clipboard copy.
 */
function stripMarkdown(content: string): string {
  return content
    // Fenced code blocks — keep the code content, drop the fences
    .replace(/```[\w]*\n?([\s\S]*?)```/g, '$1')
    // Inline code
    .replace(/`([^`]+)`/g, '$1')
    // Headers
    .replace(/^#{1,6}\s+/gm, '')
    // Bold and italic (**, __, *, _)
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    // Links: [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Images: ![alt](url) → alt
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // Blockquotes
    .replace(/^>\s?/gm, '')
    // Unordered list markers
    .replace(/^[-*+]\s+/gm, '')
    // Ordered list markers
    .replace(/^\d+\.\s+/gm, '')
    // Horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Collapse multiple blank lines to single
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fallback copy using execCommand for non-secure contexts (HTTP on local network).
 * navigator.clipboard is only available in secure contexts (HTTPS/localhost).
 */
function execCommandCopy(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(ta);
  }
}

interface Props {
  role: 'user' | 'assistant';
  content: string;
  agentName?: string;
  timestamp?: number;
  streaming?: boolean;
  error?: string;
  onRetry?: () => void;
  seq?: number;
  highlightedText?: string;
  emphasis?: boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderHighlightedText(content: string, highlightedText?: string) {
  if (!highlightedText?.trim()) return content;

  const parts = content.split(new RegExp(`(${escapeRegExp(highlightedText)})`, 'ig'));
  if (parts.length === 1) return content;

  return parts.map((part, index) =>
    part.toLowerCase() === highlightedText.toLowerCase() ? (
      <mark key={`${part}-${index}`} className="rounded bg-yellow-400/30 px-0.5 text-inherit">
        {part}
      </mark>
    ) : (
      part
    )
  );
}

export const ChatMessage = memo(function ChatMessage({ role, content, agentName, timestamp, streaming, error, onRetry, seq, highlightedText, emphasis }: Props) {
  const isUser = role === 'user';
  const [copied, setCopied] = useState(false);
  // Tick every 60s so relative labels stay fresh ("just now" → "1 min ago" etc.)
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!timestamp || streaming) return;
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, [timestamp, streaming]);

  const handleCopy = useCallback(() => {
    const text = stripMarkdown(content);
    const finish = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };

    // navigator.clipboard requires a secure context (HTTPS/localhost).
    // Fall back to execCommand for HTTP (e.g. local network iPad access).
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(finish).catch(() => {
        execCommandCopy(text);
        finish();
      });
    } else {
      execCommandCopy(text);
      finish();
    }
  }, [content]);

  if (error) {
    return (
      <div className="flex justify-start mb-3">
        <div className="max-w-[80%] rounded-lg px-4 py-2 overflow-hidden bg-red-900/60 border border-red-500/40 text-red-200">
          <div className="text-xs text-red-400 mb-1 font-medium">Error</div>
          <div className="text-sm">{content}</div>
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-2 px-3 py-1 text-xs rounded bg-red-700 hover:bg-red-600 text-white transition-colors"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`} data-message-seq={seq}>
      <div
        className={`relative max-w-[80%] rounded-lg px-4 py-2 overflow-hidden transition-all ${
          isUser
            ? 'bg-accent text-white'
            : 'bg-surface-overlay text-text-primary'
        } ${emphasis ? 'ring-2 ring-yellow-400/80 shadow-[0_0_0_1px_rgba(250,204,21,0.25)]' : ''}`}
      >
        {!isUser && (
          <button
            onClick={handleCopy}
            className="absolute top-2 right-2 p-1 rounded text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Copy message"
          >
            {copied ? (
              <Check className="w-4 h-4 text-green-400" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
        )}
        {!isUser && agentName && (
          <div className="text-xs text-text-secondary mb-1 font-medium">{agentName}</div>
        )}
        <div className={`prose prose-invert prose-sm max-w-none break-words [overflow-wrap:anywhere] [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-all${!isUser ? ' pr-6' : ' [&_ol]:text-white [&_ol>li]:marker:text-white [&_ul>li]:marker:text-white'}` }>
          {highlightedText ? (
            <div>{renderHighlightedText(content, highlightedText)}</div>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizeMarkdownTables(content)}</ReactMarkdown>
          )}
        </div>
        {streaming && (
          <span className="inline-block w-2 h-4 bg-accent animate-pulse ml-1" />
        )}
        {timestamp && !streaming && (
          <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mt-1`}>
            <span
              className={`text-[10px] transition-colors cursor-default select-none ${
                isUser
                  ? 'text-white/60 hover:text-white/90'
                  : 'text-text-secondary/50 hover:text-text-secondary/80'
              }`}
              title={formatPreciseTime(timestamp)}
            >
              {formatRelativeTime(timestamp)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
});
