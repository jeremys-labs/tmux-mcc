import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgentStore } from '../stores/agentStore';
import { useUIStore } from '../stores/uiStore';
import { useAgentStatusStore } from '../stores/agentStatusStore';
import { useActiveAgent } from '../hooks/useActiveAgent';
import type { AgentStatus } from '../stores/agentStatusStore';
import { AgentAvatar } from './AgentAvatar';
import { useSupervisorStatusStore } from '../stores/supervisorStatusStore';

const VIEW_ICONS: Record<string, string> = {
  office: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4',
  channels: 'M7 8h10M7 12h6m-6 4h10M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H9l-4 3v-3H5a2 2 0 01-2-2V7a2 2 0 012-2z',
  projects: 'M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2',
};

const STATUS_ORDER: Record<AgentStatus, number> = { awaiting_input: 0, thinking: 1, idle: 2 };

function AgentRailButton({ agentKey }: { agentKey: string }) {
  const agent = useAgentStore((s) => s.agents[agentKey]);
  const activeAgentKey = useActiveAgent();
  const clearView = useUIStore((s) => s.clearView);
  const navigate = useNavigate();
  const status = useAgentStatusStore((s) => s.statuses[agentKey]);
  const supervisorStatus = useSupervisorStatusStore((s) => s.agents[agentKey]);
  const isActive = activeAgentKey === agentKey;
  const unhealthy = Boolean(supervisorStatus && (
    supervisorStatus.process.status !== 'running'
    || supervisorStatus.progress.status === 'hung'
    || supervisorStatus.progress.status === 'blocked'
  ));

  if (!agent) return null;

  return (
    <div className="relative">
      <button
        onClick={() => { navigate(`/agent/${agentKey}`); clearView(); }}
        title={unhealthy ? `${agent.name}: ${supervisorStatus?.progress.detail ?? 'runtime unavailable'}` : agent.name}
        className={[
          'rounded-full transition-opacity duration-150',
          isActive ? 'opacity-100 ring-2 ring-accent ring-offset-1 ring-offset-surface' : 'opacity-60 hover:opacity-100',
        ].join(' ')}
      >
        <AgentAvatar agentKey={agentKey} size={48} />
      </button>
      {status === 'awaiting_input' && (
        <span className="absolute top-0 right-0 w-4 h-4 rounded-full bg-accent text-[9px] font-bold text-white flex items-center justify-center pointer-events-none">
          !
        </span>
      )}
      {status === 'thinking' && (
        <span className="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-yellow-400 pointer-events-none" />
      )}
      {unhealthy && (
        <span className="absolute bottom-0 left-0 w-3.5 h-3.5 rounded-full bg-red-500 ring-2 ring-surface pointer-events-none" />
      )}
    </div>
  );
}

function ViewButton({ view, icon }: { view: 'office' | 'channels' | 'projects'; icon: string }) {
  const activeView = useUIStore((s) => s.activeView);
  const setView = useUIStore((s) => s.setView);
  const isActive = activeView === view;

  return (
    <button
      onClick={() => setView(view)}
      title={view.charAt(0).toUpperCase() + view.slice(1)}
      className={[
        'w-10 h-10 rounded-lg flex items-center justify-center transition-colors',
        isActive ? 'bg-accent/20 text-accent' : 'text-text-secondary hover:text-text-primary hover:bg-white/5',
      ].join(' ')}
    >
      <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
      </svg>
    </button>
  );
}

export function AgentRail() {
  const agents = useAgentStore((s) => s.agents);
  const statuses = useAgentStatusStore((s) => s.statuses);
  const agentKeys = useMemo(() => {
    return Object.keys(agents).sort((a, b) => {
      const sa = STATUS_ORDER[statuses[a] ?? 'idle'];
      const sb = STATUS_ORDER[statuses[b] ?? 'idle'];
      return sa - sb;
    });
  }, [agents, statuses]);

  return (
    <nav className="w-16 h-full flex flex-col items-center bg-surface border-r border-white/10 shrink-0 py-3 gap-1">
      {/* Agent buttons */}
      <div className="flex flex-col items-center gap-2 flex-1 overflow-y-auto overflow-x-hidden scrollbar-none">
        {agentKeys.map((key) => (
          <AgentRailButton key={key} agentKey={key} />
        ))}
      </div>

      {/* View icons */}
      <div className="flex flex-col items-center gap-1 pb-1">
        <div className="w-8 h-px bg-white/10 mb-1" />
        {(Object.entries(VIEW_ICONS) as ['office' | 'channels' | 'projects', string][]).map(([view, icon]) => (
          <ViewButton key={view} view={view} icon={icon} />
        ))}
      </div>
    </nav>
  );
}
