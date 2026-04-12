import { useEffect } from 'react';
import { useProjectStore, type Project } from '../stores/projectStore';
import { useUIStore } from '../stores/uiStore';

/**
 * Format a lastUpdated ISO string as a compact age label, e.g. "2h ago", "3d ago".
 */
function formatAge(iso: string): string {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 2) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffDays < 60) return `${diffWeeks}w ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}

const COLUMNS: { id: string; label: string; statuses: Project['status'][] }[] = [
  { id: 'active', label: 'Active Development', statuses: ['active'] },
  { id: 'ready', label: 'Ready to Build', statuses: ['ready'] },
  { id: 'shipped', label: 'Shipped / Internal', statuses: ['shipped'] },
  { id: 'paused', label: 'Paused / Concept', statuses: ['paused', 'concept'] },
];

function ProjectCard({ project }: { project: Project }) {
  const openAgentPanel = useUIStore((s) => s.openAgentPanel);

  return (
    <button
      onClick={() => openAgentPanel(project.owner)}
      className="w-full text-left bg-surface-overlay border border-white/10 rounded-lg p-3 hover:border-accent/40 hover:bg-accent/5 transition-colors cursor-pointer"
    >
      <div className="flex items-start gap-2 mb-1.5">
        <span className="text-lg leading-none mt-0.5 shrink-0">{project.emoji}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text-primary leading-tight truncate">{project.name}</div>
          <div className="text-xs text-text-secondary mt-0.5">{project.ownerName}</div>
        </div>
      </div>

      <p className="text-xs text-text-secondary leading-snug mb-2">{project.summary}</p>

      {project.nextStep && (
        <div className="flex items-start gap-1.5 mb-2">
          <span className="shrink-0 bg-blue-500/20 text-blue-400 text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide">
            Next
          </span>
          <span className="text-xs text-blue-300/90 leading-snug">{project.nextStep}</span>
        </div>
      )}

      {project.blocker && (
        <div className="flex items-start gap-1.5 mb-2">
          <span className="shrink-0 bg-red-500/20 text-red-400 text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide">
            Blocker
          </span>
          <span className="text-xs text-red-400/90 leading-snug">{project.blocker}</span>
        </div>
      )}

      {project.lastUpdated && (
        <div className="text-[10px] text-text-secondary/40 mt-1 text-right">
          updated {formatAge(project.lastUpdated)}
        </div>
      )}
    </button>
  );
}

function KanbanColumn({ column, projects }: { column: typeof COLUMNS[number]; projects: Project[] }) {
  return (
    <div className="flex flex-col min-w-0 md:min-w-52">
      <div className="flex items-center gap-2 mb-3 px-1">
        <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">{column.label}</h2>
        <span className="text-xs text-text-secondary/60 bg-white/5 rounded px-1.5 py-0.5">{projects.length}</span>
      </div>
      <div className="flex flex-col gap-2">
        {projects.length === 0 ? (
          <div className="text-xs text-text-secondary/40 italic px-1">No projects</div>
        ) : (
          projects.map((p) => <ProjectCard key={p.id} project={p} />)
        )}
      </div>
    </div>
  );
}

export function ProjectsView() {
  const projects = useProjectStore((s) => s.projects);
  const loading = useProjectStore((s) => s.loading);
  const error = useProjectStore((s) => s.error);
  const fetchProjects = useProjectStore((s) => s.fetchProjects);

  useEffect(() => {
    fetchProjects();
    const interval = setInterval(fetchProjects, 5 * 60_000);
    return () => clearInterval(interval);
  }, [fetchProjects]);

  if (loading) {
    return (
      <div className="h-full w-full flex items-center justify-center text-text-secondary text-sm">
        Loading projects...
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full w-full flex items-center justify-center text-red-400 text-sm">
        Failed to load projects: {error}
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-auto p-4 md:p-6">
      <div className="mb-5 flex items-start justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold text-text-primary">Projects</h1>
          <p className="text-xs text-text-secondary mt-0.5">{projects.length} project{projects.length !== 1 ? 's' : ''} · Click a card to chat with the owner</p>
        </div>
        <button
          onClick={() => fetchProjects()}
          title="Refresh projects"
          className="shrink-0 p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-white/10 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      {/* Kanban board — horizontal scroll on desktop, stacked on mobile */}
      <div className="flex flex-col gap-6 md:flex-row md:gap-4 md:items-start">
        {COLUMNS.map((col) => {
          const colProjects = projects.filter((p) => col.statuses.includes(p.status));
          return <KanbanColumn key={col.id} column={col} projects={colProjects} />;
        })}
      </div>
    </div>
  );
}
