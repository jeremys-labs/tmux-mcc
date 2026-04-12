import { useState, useEffect, lazy, Suspense } from 'react';
import { useConfig } from './hooks/useConfig';
import { useUIStore } from './stores/uiStore';
import { useAgentStore } from './stores/agentStore';
import { useConnectionStore } from './stores/connectionStore';
import { DashboardLayout } from './layouts/DashboardLayout';
import { ChatPanel } from './components/ChatPanel';

// Lazy-load PixiJS canvas to keep initial bundle small
const OfficeCanvas = lazy(() => import('./canvas/OfficeCanvas').then(m => ({ default: m.OfficeCanvas })));
import { AgentInfoTabs } from './components/AgentInfoTabs';
import { ChannelsView } from './components/ChannelsView';
import { FileReview } from './components/FileReview';
import { StandupWidget } from './components/StandupWidget';
import { ProjectsView } from './components/ProjectsView';

export default function App() {
  useConfig();
  const activeView = useUIStore((s) => s.activeView);
  const activeAgent = useUIStore((s) => s.activeAgent);
  const panelOpen = useUIStore((s) => s.panelOpen);
  const panelExpanded = useUIStore((s) => s.panelExpanded);
  const closePanel = useUIStore((s) => s.closePanel);
  const togglePanelExpanded = useUIStore((s) => s.togglePanelExpanded);
  const loading = useAgentStore((s) => s.loading);
  const error = useAgentStore((s) => s.error);
  const setGatewayStatus = useConnectionStore((s) => s.setGatewayStatus);
  const setMetrics = useConnectionStore((s) => s.setMetrics);

  // Health check poller
  useEffect(() => {
    let mounted = true;

    async function checkHealth() {
      const start = Date.now();
      try {
        const res = await fetch('/api/health');
        const latency = Date.now() - start;
        if (!res.ok) throw new Error('Health check failed');
        const data = await res.json();
        if (!mounted) return;
        setMetrics({ latency });
        if (data.gateway === 'connected' || data.gateway === true) {
          setGatewayStatus('connected');
        } else if (data.gateway === 'reconnecting') {
          setGatewayStatus('reconnecting');
        } else {
          setGatewayStatus('disconnected');
        }
      } catch {
        if (mounted) {
          setGatewayStatus('disconnected');
          setMetrics({ latency: 0 });
        }
      }
    }

    checkHealth();
    const interval = setInterval(checkHealth, 30_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [setGatewayStatus]);

  // Global keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        closePanel();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closePanel]);

  if (loading) {
    return (
      <div className="h-screen w-screen bg-surface flex items-center justify-center text-text-secondary">
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen w-screen bg-surface flex items-center justify-center text-red-400">
        Error: {error}
      </div>
    );
  }

  return (
    <DashboardLayout>
      <div className="flex h-full w-full">
        {/* Main content area */}
        <div className="flex-1 relative overflow-hidden">
          {activeView === 'office' && (
            <>
              <Suspense fallback={
                <div className="h-full w-full bg-surface flex items-center justify-center text-text-secondary">
                  Loading office...
                </div>
              }>
                <OfficeCanvas />
              </Suspense>
              <div className="absolute top-2 left-2 right-2 max-w-56 md:top-4 md:left-4 md:right-auto md:max-w-72 z-10">
                <StandupWidget />
              </div>
            </>
          )}
          {activeView === 'channels' && <ChannelsView />}
          {activeView === 'files' && <FileReview />}
          {activeView === 'projects' && <ProjectsView />}
        </div>

        {/* Agent side panel - sidebar on desktop, slide-up sheet on mobile */}
        {panelOpen && activeAgent && (
          <>
            {/* Mobile overlay backdrop */}
            <div
              className="fixed inset-0 bg-black/50 z-40 md:hidden"
              onClick={() => closePanel()}
            />
            <aside
              className={[
                // Mobile: slide-up full-height sheet
                'fixed inset-x-0 bottom-0 z-50 bg-surface-raised flex flex-col',
                'h-[85vh] rounded-t-2xl',
                'transition-transform duration-300 ease-out',
                // Desktop: static sidebar
                'md:static md:inset-auto md:z-auto md:h-auto md:rounded-none',
                'md:border-l md:border-white/10 md:shrink-0',
                'md:transition-[width] md:duration-200 md:ease-out',
                panelExpanded ? 'md:w-[48rem]' : 'md:w-96',
              ].join(' ')}
            >
              {/* Mobile drag handle */}
              <div className="flex items-center justify-center pt-2 pb-1 md:hidden">
                <div className="w-10 h-1 rounded-full bg-white/20" />
              </div>
              <div className="flex border-b border-white/10">
                <button
                  onClick={togglePanelExpanded}
                  className="hidden md:block px-3 py-2 text-xs text-text-secondary hover:text-text-primary"
                  title={panelExpanded ? 'Collapse panel' : 'Expand panel'}
                >
                  {panelExpanded ? '\u25B6' : '\u25C0'}
                </button>
                <button
                  onClick={() => closePanel()}
                  className="ml-auto px-3 py-2 text-xs text-text-secondary hover:text-text-primary"
                >
                  Close
                </button>
              </div>
              {/* Panel tabs: Chat and Info */}
              <PanelTabs agentKey={activeAgent} />
            </aside>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

function PanelTabs({ agentKey }: { agentKey: string }) {
  const [tab, setTab] = useState<'chat' | 'info'>('chat');
  const agent = useAgentStore((s) => s.agents[agentKey]);
  const hasTabs = agent?.tabs && agent.tabs.length > 0;

  return (
    <>
      {hasTabs && (
        <div className="flex border-b border-white/10 shrink-0">
          <button
            onClick={() => setTab('chat')}
            className={`flex-1 px-3 py-2 text-xs ${tab === 'chat' ? 'text-accent border-b-2 border-accent' : 'text-text-secondary'}`}
          >
            Chat
          </button>
          <button
            onClick={() => setTab('info')}
            className={`flex-1 px-3 py-2 text-xs ${tab === 'info' ? 'text-accent border-b-2 border-accent' : 'text-text-secondary'}`}
          >
            Info
          </button>
        </div>
      )}
      <div className="flex-1 overflow-hidden">
        {tab === 'chat' ? <ChatPanel agentKey={agentKey} /> : <AgentInfoTabs agentKey={agentKey} />}
      </div>
    </>
  );
}
