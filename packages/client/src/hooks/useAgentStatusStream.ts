import { useEffect } from 'react';
import { useAgentStatusStore } from '../stores/agentStatusStore';

/**
 * Subscribes to the server's SSE stream and keeps agentStatusStore in sync.
 * Mount once at the app root.
 */
export function useAgentStatusStream() {
  const setStatus = useAgentStatusStore((s) => s.setStatus);

  useEffect(() => {
    const es = new EventSource('/api/agent-status/stream');

    es.onmessage = (e) => {
      try {
        const { agentKey, status } = JSON.parse(e.data);
        if (agentKey && status) setStatus(agentKey, status);
      } catch {
        // malformed event — ignore
      }
    };

    es.onerror = () => {
      // EventSource reconnects automatically — no action needed
    };

    return () => es.close();
  }, [setStatus]);
}
