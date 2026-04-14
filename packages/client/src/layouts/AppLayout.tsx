import { AgentRail } from '../components/AgentRail';
import { RightPanel } from '../components/RightPanel';
import { MobileNav } from '../components/MobileNav';
import { MobileInfoSheet } from '../components/MobileInfoSheet';
import { useActiveAgent } from '../hooks/useActiveAgent';
import { ConnectionStatus } from '../components/ConnectionStatus';
import { useUIStore } from '../stores/uiStore';

export function AppLayout({ children }: { children: React.ReactNode }) {
  const activeAgent = useActiveAgent();
  const fileSplitOpen = useUIStore((s) => s.fileSplitOpen);

  return (
    <div className="h-screen w-screen flex bg-surface text-text-primary overflow-hidden">
      {/* Left rail — desktop only */}
      <div className="hidden md:flex">
        <AgentRail />
      </div>

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Top bar */}
        <header className="bg-surface-raised border-b border-white/10 flex items-center px-4 h-10 shrink-0">
          <h1 className="text-sm font-semibold text-text-secondary">MCC</h1>
          <div className="ml-auto">
            <ConnectionStatus />
          </div>
        </header>

        {/* Center + right panel — add bottom padding on mobile for nav bar */}
        <div className="flex-1 flex overflow-hidden pb-[56px] md:pb-0">
          <div className="flex-1 overflow-hidden min-w-0">
            {children}
          </div>
          {/* Right panel — desktop only, hidden when file browser is open */}
          {activeAgent && !fileSplitOpen && (
            <div className="hidden md:flex">
              <RightPanel />
            </div>
          )}
        </div>
      </div>

      {/* Mobile bottom navigation */}
      <MobileNav />

      {/* Mobile info sheet (agent info overlay) */}
      <MobileInfoSheet />
    </div>
  );
}
