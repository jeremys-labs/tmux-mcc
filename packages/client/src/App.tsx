import { useEffect, lazy, Suspense } from 'react';
import { Routes, Route, useParams } from 'react-router-dom';
import { useConfig } from './hooks/useConfig';
import { useAgentStatusStream } from './hooks/useAgentStatusStream';
import { useUIStore } from './stores/uiStore';
import { useAgentStore } from './stores/agentStore';
import { useConnectionStore } from './stores/connectionStore';
import { AppLayout } from './layouts/AppLayout';
import { TerminalPanel } from './components/TerminalPanel.js';
import { ChannelsView } from './components/ChannelsView';
import { FileReview } from './components/FileReview';
import { StandupWidget } from './components/StandupWidget';
import { ProjectsView } from './components/ProjectsView';
import { ResizableSplit } from './components/ResizableSplit';

// Lazy-load PixiJS canvas to keep initial bundle small
const OfficeCanvas = lazy(() => import('./canvas/OfficeCanvas').then(m => ({ default: m.OfficeCanvas })));

export default function App() {
  useConfig();
  useAgentStatusStream();
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
  }, [setGatewayStatus, setMetrics]);

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
    <AppLayout>
      <Routes>
        <Route path="/agent/:agentKey" element={<AgentCenterPane />} />
        <Route path="*" element={<CenterPane activeAgent={null} />} />
      </Routes>
    </AppLayout>
  );
}

function AgentCenterPane() {
  const { agentKey } = useParams<{ agentKey: string }>();
  return <CenterPane activeAgent={agentKey ?? null} />;
}

function CenterPane({
  activeAgent,
}: {
  activeAgent: string | null;
}) {
  const activeView = useUIStore((s) => s.activeView);
  const fileSplitOpen = useUIStore((s) => s.fileSplitOpen);
  const toggleFileSplit = useUIStore((s) => s.toggleFileSplit);

  // View takes priority over terminal
  if (activeView === 'office') {
    return (
      <div className="h-full w-full relative overflow-hidden">
        <Suspense fallback={
          <div className="h-full w-full flex items-center justify-center text-text-secondary">
            Loading office...
          </div>
        }>
          <OfficeCanvas />
        </Suspense>
        <div className="absolute top-2 left-2 right-2 max-w-56 md:top-4 md:left-4 md:right-auto md:max-w-72 z-10">
          <StandupWidget />
        </div>
      </div>
    );
  }

  if (activeView === 'channels') return <ChannelsView />;
  if (activeView === 'projects') return <ProjectsView />;

  // No view selected — show terminal for active agent, or empty state
  if (activeAgent) {
    return (
      <div className="flex flex-col h-full w-full">
        {/* Toolbar — desktop only (file split not supported on mobile) */}
        <div className="hidden md:flex items-center justify-end px-2 py-1 border-b border-white/10 shrink-0 bg-surface-raised">
          <button
            onClick={toggleFileSplit}
            title={fileSplitOpen ? 'Close file browser' : 'Open file browser'}
            className="px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
          >
            {fileSplitOpen ? '⊟ Files' : '⊞ Files'}
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          <ResizableSplit
            left={<TerminalPanel key={activeAgent} agentKey={activeAgent} />}
            right={<FileReview />}
            rightVisible={fileSplitOpen}
            defaultRightWidth={600}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex items-center justify-center text-text-secondary text-sm">
      Select an agent to start chatting
    </div>
  );
}
