import { useEffect } from 'react';
import { useAgentStore } from '../stores/agentStore';

export function useConfig() {
  const { setAgents, setError, loading } = useAgentStore();

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((data) => setAgents(data.agents))
      .catch((err) => setError(err.message));
  }, [setAgents, setError]);

  return { loading };
}
