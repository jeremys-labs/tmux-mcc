import { useState, useEffect, useRef } from 'react';

interface SearchResult {
  seq: number;
  role: string;
  snippet: string;
  timestamp: number;
}

interface Props {
  agentKey: string;
  onClose: () => void;
}

const DEBOUNCE_MS = 300;

export function AgentSearch({ agentKey, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced search
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults(null);
      return;
    }

    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/search?agent=${encodeURIComponent(agentKey)}&q=${encodeURIComponent(trimmed)}`
        );
        const data = await res.json();
        setResults(data.results ?? []);
        setTotal(data.total ?? 0);
      } catch {
        setResults([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, agentKey]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <div className="flex flex-col border-b border-white/10 bg-surface-raised shrink-0">
      {/* Search input row */}
      <div className="flex items-center gap-2 px-3 py-2">
        <svg
          className="w-4 h-4 text-text-secondary shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"
          />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search conversation history…"
          className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-secondary/50 outline-none"
        />
        {loading && (
          <span className="text-[10px] text-text-secondary animate-pulse">searching…</span>
        )}
        {results !== null && !loading && (
          <span className="text-[10px] text-text-secondary">
            {total === 0 ? 'No results' : `${total} result${total === 1 ? '' : 's'}`}
          </span>
        )}
        <button
          onClick={onClose}
          className="text-text-secondary hover:text-text-primary text-sm px-1"
          title="Close search (Esc)"
        >
          ×
        </button>
      </div>

      {/* Results list */}
      {results !== null && results.length > 0 && (
        <div className="max-h-48 overflow-y-auto border-t border-white/5 divide-y divide-white/5">
          {results.map((r) => (
            <div key={r.seq} className="px-3 py-2 flex items-start gap-2 hover:bg-white/5">
              <span
                className={`text-[9px] font-medium uppercase tracking-wide mt-0.5 px-1 py-0.5 rounded shrink-0 ${
                  r.role === 'assistant'
                    ? 'bg-accent/20 text-accent'
                    : 'bg-white/10 text-text-secondary'
                }`}
              >
                {r.role}
              </span>
              <p className="text-[11px] text-text-secondary leading-relaxed min-w-0">
                {r.snippet}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
