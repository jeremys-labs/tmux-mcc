import { useAgentStore } from '../stores/agentStore';
import { useUIStore } from '../stores/uiStore';
import { AgentInfoTabs } from './AgentInfoTabs';
import { AgentAvatar } from './AgentAvatar';

export function RightPanel() {
  const activeAgent = useUIStore((s) => s.activeAgent);
  const agent = useAgentStore((s) => (activeAgent ? s.agents[activeAgent] : null));

  if (!activeAgent || !agent) return null;

  return (
    <aside className="w-80 h-full flex flex-col bg-surface-raised border-l border-white/10 shrink-0">
      {/* Agent header */}
      <div className="flex flex-col items-center gap-2 px-4 py-4 border-b border-white/10 shrink-0">
        <AgentAvatar agentKey={activeAgent} size={160} />
        <div className="text-center min-w-0 w-full">
          <div className="text-sm font-semibold text-text-primary truncate">
            {agent.name}
          </div>
          <div className="text-xs text-text-secondary truncate">{agent.role}</div>
        </div>
      </div>

      {/* Info tabs */}
      <div className="flex-1 overflow-hidden">
        <AgentInfoTabs agentKey={activeAgent} />
      </div>
    </aside>
  );
}
