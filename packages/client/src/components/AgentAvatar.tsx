import { useState } from 'react';
import { useAgentStore } from '../stores/agentStore';

interface Props {
  agentKey: string;
  size?: number;
}

export function AgentAvatar({ agentKey, size = 40 }: Props) {
  const agent = useAgentStore((s) => s.agents[agentKey]);
  const [imgError, setImgError] = useState(false);

  const gradientStyle = agent?.color
    ? { background: `linear-gradient(135deg, ${agent.color.from}, ${agent.color.to})` }
    : { background: '#334155' };

  if (agent?.avatarUrl && !imgError) {
    return (
      <img
        src={agent.avatarUrl}
        onError={() => setImgError(true)}
        className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size }}
        alt={agent.name}
      />
    );
  }

  return (
    <div
      className="rounded-full flex items-center justify-center shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.45, ...gradientStyle }}
    >
      {agent?.emoji ?? '🤖'}
    </div>
  );
}
