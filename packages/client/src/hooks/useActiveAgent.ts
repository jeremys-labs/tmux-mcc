import { useMatch } from 'react-router-dom';

/**
 * Returns the currently active agent key from the URL (/agent/:agentKey),
 * or null if no agent is selected.
 *
 * Works from any component inside the Router — does not require being
 * inside a matching Route.
 */
export function useActiveAgent(): string | null {
  const match = useMatch('/agent/:agentKey');
  return match?.params.agentKey ?? null;
}
