import { useEffect } from 'react';
import { useSupervisorStatusStore } from '../stores/supervisorStatusStore';

export function useSupervisorStatus() {
  const setStatus = useSupervisorStatusStore((state) => state.setStatus);
  const setUnavailable = useSupervisorStatusStore((state) => state.setUnavailable);

  useEffect(() => {
    let active = true;

    async function poll() {
      try {
        const response = await fetch('/api/supervisor/status');
        if (!response.ok) throw new Error(`supervisor status ${response.status}`);
        const body = await response.json();
        if (active) setStatus(Array.isArray(body.agents) ? body.agents : []);
      } catch {
        if (active) setUnavailable();
      }
    }

    void poll();
    const timer = setInterval(poll, 10_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [setStatus, setUnavailable]);
}
