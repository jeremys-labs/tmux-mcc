import { useUIStore } from '../stores/uiStore';
import { useAgentStore } from '../stores/agentStore';
import { AgentAvatar } from './AgentAvatar';
import { AgentInfoTabs } from './AgentInfoTabs';

export function MobileInfoSheet() {
  const mobileInfoOpen = useUIStore((s) => s.mobileInfoOpen);
  const setMobileInfoOpen = useUIStore((s) => s.setMobileInfoOpen);
  const activeAgent = useUIStore((s) => s.activeAgent);
  const agent = useAgentStore((s) => (activeAgent ? s.agents[activeAgent] : null));

  if (!activeAgent || !agent) return null;

  return (
    <>
      {/* Backdrop */}
      {mobileInfoOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-40"
          onClick={() => setMobileInfoOpen(false)}
        />
      )}

      {/* Sheet */}
      <div
        className={[
          'md:hidden fixed inset-x-0 bottom-0 z-50 bg-surface-raised rounded-t-2xl flex flex-col',
          'h-[85vh] transition-transform duration-300 ease-out safe-area-pb',
          mobileInfoOpen ? 'translate-y-0' : 'translate-y-full',
        ].join(' ')}
      >
        {/* Drag handle */}
        <div className="flex items-center justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full bg-white/20" />
        </div>

        {/* Agent header */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-white/10 shrink-0">
          <AgentAvatar agentKey={activeAgent} size={36} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-text-primary truncate">{agent.name}</div>
            <div className="text-xs text-text-secondary truncate">{agent.role}</div>
          </div>
          <button
            onClick={() => setMobileInfoOpen(false)}
            className="text-text-secondary px-2 py-1 text-xs"
          >
            Close
          </button>
        </div>

        {/* Info tabs */}
        <div className="flex-1 overflow-hidden">
          <AgentInfoTabs agentKey={activeAgent} />
        </div>
      </div>
    </>
  );
}
