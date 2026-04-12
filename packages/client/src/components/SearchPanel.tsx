import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Search, X, Loader2 } from 'lucide-react';
import { useSearch } from '../hooks/useSearch';
import { ChatMessage } from './ChatMessage';

interface Props {
  agentKey: string;
  onClose: () => void;
  onJumpToMessage: (seq: number) => void;
}

export function SearchPanel({ agentKey, onClose, onJumpToMessage }: Props) {
  const { query, isSearching, results, totalResults, error, search, clearSearch } = useSearch(agentKey);
  const [inputValue, setInputValue] = useState('');
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveResultIndex(0);
  }, [query, totalResults]);

  const activeResult = useMemo(() => results[activeResultIndex] ?? null, [results, activeResultIndex]);

  const handleSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      search(inputValue);
    },
    [inputValue, search]
  );

  const handleClear = useCallback(() => {
    setInputValue('');
    clearSearch();
    setActiveResultIndex(0);
  }, [clearSearch]);

  const handleJump = useCallback(
    (seq: number) => {
      onJumpToMessage(seq);
    },
    [onJumpToMessage]
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      if (totalResults === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveResultIndex((index) => Math.min(index + 1, totalResults - 1));
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveResultIndex((index) => Math.max(index - 1, 0));
        return;
      }

      if (e.key === 'Enter' && !e.currentTarget.value.trim() && activeResult) {
        e.preventDefault();
        handleJump(activeResult.seq);
      }
    },
    [activeResult, handleJump, onClose, totalResults]
  );

  return (
    <div className="flex flex-col h-full bg-surface-raised border-l border-white/10">
      {/* Header */}
      <div className="p-4 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2 mb-3">
          <Search className="w-4 h-4 text-text-secondary" />
          <h3 className="text-sm font-semibold">Search Messages</h3>
          <button
            onClick={onClose}
            className="ml-auto p-1 hover:bg-surface-overlay rounded transition-colors"
            aria-label="Close search"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search input */}
        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Search messages..."
            className="flex-1 px-3 py-2 text-sm bg-surface-input border border-white/10 rounded focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20"
            disabled={isSearching}
          />
          <button
            type="submit"
            disabled={isSearching || !inputValue.trim()}
            className="px-3 py-2 text-sm bg-primary hover:bg-primary/90 disabled:bg-primary/50 rounded font-medium transition-colors disabled:cursor-not-allowed"
          >
            {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Search'}
          </button>
        </form>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto p-4">
        {error && (
          <div className="p-3 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-200 mb-4">
            {error}
          </div>
        )}

        {query && totalResults === 0 && !isSearching && (
          <div className="text-center py-8">
            <p className="text-text-secondary text-sm">No messages found for "{query}"</p>
          </div>
        )}

        {totalResults > 0 && (
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-xs text-text-secondary">
              Found {totalResults} message{totalResults !== 1 ? 's' : ''} matching "{query}"
            </p>
            <p className="text-[11px] text-text-secondary">
              {activeResultIndex + 1} / {totalResults} selected
            </p>
          </div>
        )}

        {results.map((msg, index) => (
          <div
            key={msg.seq}
            className={`mb-3 rounded-xl border p-3 transition-colors ${index === activeResultIndex ? 'border-primary/60 bg-primary/10' : 'border-white/10 bg-surface-overlay/60'}`}
          >
            <ChatMessage
              seq={msg.seq}
              role={msg.role}
              content={msg.snippet || msg.content}
              timestamp={msg.timestamp}
              highlightedText={query}
              emphasis
            />
            <div className="mt-2 flex items-center justify-between gap-3 px-1">
              <span className="text-[11px] text-text-secondary">
                {msg.matchCount || 1} match{msg.matchCount === 1 ? '' : 'es'} in message
              </span>
              <button
                onClick={() => handleJump(msg.seq)}
                className="px-2.5 py-1.5 text-xs rounded-lg border border-white/10 bg-surface-raised text-text-primary hover:bg-surface-overlay transition-colors"
              >
                Jump to message
              </button>
            </div>
          </div>
        ))}

        {isSearching && (
          <div className="flex justify-center py-4">
            <Loader2 className="w-5 h-5 animate-spin text-text-secondary" />
          </div>
        )}
      </div>

      {/* Footer with clear button */}
      {query && (
        <div className="p-3 border-t border-white/10 shrink-0">
          <button
            onClick={handleClear}
            className="w-full px-3 py-2 text-sm text-text-secondary hover:text-text-primary bg-surface-overlay hover:bg-surface-raised rounded transition-colors"
          >
            Clear search
          </button>
        </div>
      )}
    </div>
  );
}
