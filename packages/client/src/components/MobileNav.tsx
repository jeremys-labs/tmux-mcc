import { useNavigate } from 'react-router-dom';
import { useAgentStore } from '../stores/agentStore';
import { useUIStore } from '../stores/uiStore';
import { useAgentStatusStore } from '../stores/agentStatusStore';
import { useActiveAgent } from '../hooks/useActiveAgent';
import { AgentAvatar } from './AgentAvatar';
import { useSupervisorStatusStore } from '../stores/supervisorStatusStore';

const VIEW_ICONS: Record<string, string> = {
  office: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4',
  channels: 'M7 8h10M7 12h6m-6 4h10M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H9l-4 3v-3H5a2 2 0 01-2-2V7a2 2 0 012-2z',
  projects: 'M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2',
};

export function MobileNav() {
  const agents = useAgentStore((s) => s.agents);
  const activeAgentKey = useActiveAgent();
  const activeView = useUIStore((s) => s.activeView);
  const clearView = useUIStore((s) => s.clearView);
  const setView = useUIStore((s) => s.setView);
  const navigate = useNavigate();
  const statuses = useAgentStatusStore((s) => s.statuses);
  const supervisorStatuses = useSupervisorStatusStore((s) => s.agents);

  const agentKeys = Object.keys(agents).sort((a, b) => {
    const order = { awaiting_input: 0, thinking: 1, idle: 2 };
    return (order[statuses[a] ?? 'idle']) - (order[statuses[b] ?? 'idle']);
  });

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-surface-raised border-t border-white/10 safe-area-pb">
      <div className="flex items-center gap-2 px-3 py-2 overflow-x-auto">
        {/* Agent avatars */}
        {agentKeys.map((key) => {
          const isActive = activeAgentKey === key && !activeView;
          const status = statuses[key];
          const supervisorStatus = supervisorStatuses[key];
          const unhealthy = Boolean(supervisorStatus && (
            supervisorStatus.process.status !== 'running' || supervisorStatus.progress.status === 'hung'
          ));
          return (
            <div key={key} className="relative shrink-0">
              <button
                onClick={() => { navigate(`/agent/${key}`); clearView(); }}
                className={[
                  'rounded-full transition-opacity',
                  isActive ? 'opacity-100 ring-2 ring-accent ring-offset-1 ring-offset-surface-raised' : 'opacity-50',
                ].join(' ')}
              >
                <AgentAvatar agentKey={key} size={36} />
              </button>
              {status === 'awaiting_input' && (
                <span className="absolute top-0 right-0 w-3.5 h-3.5 rounded-full bg-accent text-[8px] font-bold text-white flex items-center justify-center pointer-events-none">!</span>
              )}
              {status === 'thinking' && (
                <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-yellow-400 pointer-events-none" />
              )}
              {unhealthy && (
                <span className="absolute bottom-0 left-0 w-3 h-3 rounded-full bg-red-500 ring-2 ring-surface-raised pointer-events-none" />
              )}
            </div>
          );
        })}

        {/* Divider */}
        <div className="w-px h-7 bg-white/15 shrink-0 mx-1" />

        {/* View buttons */}
        {(Object.entries(VIEW_ICONS) as ['office' | 'channels' | 'projects', string][]).map(([view, icon]) => (
          <button
            key={view}
            onClick={() => setView(view)}
            className={[
              'w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-colors',
              activeView === view ? 'bg-accent/20 text-accent' : 'text-text-secondary',
            ].join(' ')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
            </svg>
          </button>
        ))}
      </div>
    </nav>
  );
}
