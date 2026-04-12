import { useState, useCallback } from 'react';

interface SearchMessage {
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  snippet?: string;
  matchIndex?: number;
  matchCount?: number;
}

/**
 * Client-side search utility for filtering message arrays.
 * Used as fallback for immediate search results before API call completes.
 */
export function searchMessages(messages: SearchMessage[], query: string): SearchMessage[] {
  if (!query.trim()) return messages;
  const queryLower = query.toLowerCase();
  return messages
    .filter((msg) => msg.content.toLowerCase().includes(queryLower))
    .map((msg) => ({
      ...msg,
      snippet: msg.content,
      matchIndex: msg.content.toLowerCase().indexOf(queryLower),
      matchCount: msg.content.toLowerCase().split(queryLower).length - 1,
    }));
}

interface UseSearchState {
  query: string;
  isSearching: boolean;
  results: SearchMessage[];
  totalResults: number;
  error: string | null;
}

/**
 * Hook for searching through an agent's message history.
 * Performs search via the backend API endpoint.
 */
export function useSearch(agentKey: string) {
  const [state, setState] = useState<UseSearchState>({
    query: '',
    isSearching: false,
    results: [],
    totalResults: 0,
    error: null,
  });

  const search = useCallback(
    async (query: string) => {
      if (!query.trim()) {
        setState({
          query: '',
          isSearching: false,
          results: [],
          totalResults: 0,
          error: null,
        });
        return;
      }

      setState((s) => ({ ...s, query, isSearching: true, error: null }));

      try {
        const response = await fetch(
          `/api/search?agent=${encodeURIComponent(agentKey)}&q=${encodeURIComponent(query)}`
        );

        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: 'Search failed' }));
          throw new Error(error.error || 'Search failed');
        }

        const data = await response.json();

        setState({
          query,
          isSearching: false,
          results: data.results || [],
          totalResults: data.total || 0,
          error: null,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Search error';
        setState((s) => ({
          ...s,
          isSearching: false,
          error: errorMsg,
          results: [],
          totalResults: 0,
        }));
      }
    },
    [agentKey]
  );

  const clearSearch = useCallback(() => {
    setState({
      query: '',
      isSearching: false,
      results: [],
      totalResults: 0,
      error: null,
    });
  }, []);

  return {
    ...state,
    search,
    clearSearch,
  };
}
