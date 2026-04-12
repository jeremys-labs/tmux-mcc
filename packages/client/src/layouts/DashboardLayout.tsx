import { useUIStore } from '../stores/uiStore';
import { ConnectionStatus } from '../components/ConnectionStatus';

const NAV_ICONS: Record<string, string> = {
  office: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4',
  channels: 'M7 8h10M7 12h6m-6 4h10M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H9l-4 3v-3H5a2 2 0 01-2-2V7a2 2 0 012-2z',
  files: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  projects: 'M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2',
};

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { activeView, setView } = useUIStore();

  return (
    <div className="h-screen w-screen bg-surface text-text-primary flex flex-col overflow-hidden">
      {/* Desktop top nav */}
      <header className="bg-surface-raised border-b border-white/10 hidden md:flex items-center px-4 pt-[env(safe-area-inset-top)] pb-1 shrink-0">
        <h1 className="text-sm font-semibold">OpenClaw Office</h1>
        <nav className="ml-auto flex gap-2">
          <ConnectionStatus />
          {(['office', 'channels', 'files', 'projects'] as const).map((view) => (
            <button
              key={view}
              onClick={() => setView(view)}
              className={`px-3 py-1 text-xs rounded capitalize ${
                activeView === view ? 'bg-accent/20 text-accent' : 'bg-surface-overlay hover:bg-accent/10 text-text-secondary'
              }`}
            >
              {view}
            </button>
          ))}
        </nav>
      </header>

      {/* Mobile top bar - minimal branding + connection status */}
      <header className="bg-surface-raised border-b border-white/10 flex md:hidden items-center px-4 pt-[env(safe-area-inset-top)] pb-1 shrink-0">
        <h1 className="text-sm font-semibold">OpenClaw Office</h1>
        <div className="ml-auto">
          <ConnectionStatus />
        </div>
      </header>

      {/* Main content - add bottom padding on mobile for bottom nav */}
      <div className="flex-1 flex overflow-hidden relative pb-14 md:pb-0">
        {children}
      </div>

      {/* Mobile bottom tab bar */}
      <nav className="fixed bottom-0 left-0 right-0 h-14 bg-surface-raised border-t border-white/10 flex items-center justify-around px-4 z-50 md:hidden safe-area-pb">
        {(['office', 'channels', 'files', 'projects'] as const).map((view) => (
          <button
            key={view}
            onClick={() => setView(view)}
            className={`flex flex-col items-center gap-0.5 py-1 px-3 ${
              activeView === view ? 'text-accent' : 'text-text-secondary'
            }`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d={NAV_ICONS[view]} />
            </svg>
            <span className="text-[10px] capitalize">{view}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
