import { useEffect, useState, useCallback } from 'react';
import { FileViewer } from './FileViewer';
import { FileActions } from './FileActions';

interface DirEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
}

type Mode = 'docs' | 'inbox' | 'approved' | 'archive';

export function FileReview() {
  const [mode, setMode] = useState<Mode>('docs');
  const [dirPath, setDirPath] = useState('');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Review folder files (flat)
  const [reviewFiles, setReviewFiles] = useState<Record<string, string[]>>({
    inbox: [],
    approved: [],
    archive: [],
  });

  const loadDocs = useCallback((p: string) => {
    fetch(`/api/docs?path=${encodeURIComponent(p)}`)
      .then((r) => r.json())
      .then((data) => {
        setEntries(data.entries || []);
        setDirPath(data.path || '');
      });
  }, []);

  const loadReviewFiles = useCallback(() => {
    fetch('/api/files')
      .then((r) => r.json())
      .then(setReviewFiles);
  }, []);

  useEffect(() => {
    if (mode === 'docs') {
      loadDocs(dirPath);
    } else {
      loadReviewFiles();
    }
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const navigateTo = (name: string) => {
    const newPath = dirPath ? `${dirPath}/${name}` : name;
    setSelectedFile(null);
    setDirPath(newPath);
    loadDocs(newPath);
  };

  const navigateUp = () => {
    const parts = dirPath.split('/').filter(Boolean);
    parts.pop();
    const newPath = parts.join('/');
    setSelectedFile(null);
    setDirPath(newPath);
    loadDocs(newPath);
  };

  const selectDocFile = (name: string) => {
    const filePath = dirPath ? `${dirPath}/${name}` : name;
    setSelectedFile(filePath);
    // Auto-collapse sidebar on mobile when a file is selected
    if (window.innerWidth < 768) setSidebarOpen(false);
  };

  const moveFile = async (filename: string, from: string, to: string) => {
    await fetch(`/api/files/${from}/${filename}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to }),
    });
    setSelectedFile(null);
    loadReviewFiles();
  };

  const isReviewMode = mode !== 'docs';
  const currentReviewFiles = isReviewMode ? reviewFiles[mode] || [] : [];

  // File viewer URL depends on mode
  const fileUrl = selectedFile
    ? isReviewMode
      ? `/api/files/${mode}/${selectedFile}`
      : `/api/docs?path=${encodeURIComponent(selectedFile)}`
    : null;

  return (
    <div className="flex flex-col h-full">
      {/* Mode tabs */}
      <div className="flex overflow-x-auto border-b border-white/10 shrink-0">
        {([
          { key: 'docs', label: 'Workspace Docs' },
          { key: 'inbox', label: 'Inbox' },
          { key: 'approved', label: 'Approved' },
          { key: 'archive', label: 'Archive' },
        ] as { key: Mode; label: string }[]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => {
              setMode(key);
              setSelectedFile(null);
            }}
            className={`px-3 py-2 text-xs whitespace-nowrap ${
              mode === key ? 'bg-accent/20 text-accent' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {label}
            {key !== 'docs' && ` (${(reviewFiles[key] || []).length})`}
          </button>
        ))}
      </div>

      <div className="flex flex-col md:flex-row flex-1 min-h-0">
        {/* Sidebar toggle (mobile) */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="md:hidden flex items-center gap-2 px-3 py-2 border-b border-white/10 text-xs text-text-secondary hover:text-text-primary shrink-0"
        >
          <span className={`transition-transform ${sidebarOpen ? 'rotate-90' : ''}`}>▶</span>
          {sidebarOpen ? 'Hide file list' : 'Show file list'}
          {!sidebarOpen && selectedFile && (
            <span className="ml-auto text-accent truncate max-w-[200px]">{selectedFile.split('/').pop()}</span>
          )}
        </button>

        {/* File list sidebar */}
        <div className={`${sidebarOpen ? 'flex' : 'hidden'} md:flex w-full md:w-64 border-r border-white/10 flex-col shrink-0 ${sidebarOpen ? 'max-h-[40vh] md:max-h-none' : ''}`}>
          {mode === 'docs' && (
            <>
              {/* Breadcrumb */}
              <div className="px-2 py-1.5 border-b border-white/5 flex items-center gap-1 text-xs text-text-secondary">
                <button
                  onClick={() => {
                    setDirPath('');
                    setSelectedFile(null);
                    loadDocs('');
                  }}
                  className="hover:text-accent"
                >
                  docs
                </button>
                {dirPath &&
                  dirPath.split('/').map((part, i, arr) => (
                    <span key={i} className="flex items-center gap-1">
                      <span>/</span>
                      <button
                        onClick={() => {
                          const newPath = arr.slice(0, i + 1).join('/');
                          setDirPath(newPath);
                          setSelectedFile(null);
                          loadDocs(newPath);
                        }}
                        className="hover:text-accent truncate max-w-[80px]"
                      >
                        {part}
                      </button>
                    </span>
                  ))}
              </div>

              {/* Directory listing */}
              <div className="flex-1 overflow-y-auto p-1">
                {dirPath && (
                  <button
                    onClick={navigateUp}
                    className="w-full text-left px-2 py-1.5 rounded text-sm text-text-secondary hover:bg-surface-overlay flex items-center gap-1.5"
                  >
                    <span className="text-xs">↑</span> ..
                  </button>
                )}
                {entries.map((entry) => (
                  <button
                    key={entry.name}
                    onClick={() =>
                      entry.type === 'directory'
                        ? navigateTo(entry.name)
                        : selectDocFile(entry.name)
                    }
                    className={`w-full text-left px-2 py-1.5 rounded text-sm truncate flex items-center gap-1.5 ${
                      selectedFile === (dirPath ? `${dirPath}/${entry.name}` : entry.name)
                        ? 'bg-accent/20'
                        : 'hover:bg-surface-overlay'
                    }`}
                  >
                    <span className="text-xs shrink-0">
                      {entry.type === 'directory' ? '📁' : '📄'}
                    </span>
                    <span className="truncate">{entry.name}</span>
                    {entry.size !== undefined && (
                      <span className="ml-auto text-[10px] text-text-secondary shrink-0">
                        {formatSize(entry.size)}
                      </span>
                    )}
                  </button>
                ))}
                {entries.length === 0 && (
                  <div className="text-xs text-text-secondary p-2">Empty folder</div>
                )}
              </div>
            </>
          )}

          {isReviewMode && (
            <div className="flex-1 overflow-y-auto p-1">
              {currentReviewFiles.map((filename) => (
                <button
                  key={filename}
                  onClick={() => {
                    setSelectedFile(filename);
                    if (window.innerWidth < 768) setSidebarOpen(false);
                  }}
                  className={`w-full text-left px-2 py-1.5 rounded text-sm truncate ${
                    selectedFile === filename ? 'bg-accent/20' : 'hover:bg-surface-overlay'
                  }`}
                >
                  {filename}
                </button>
              ))}
              {currentReviewFiles.length === 0 && (
                <div className="text-xs text-text-secondary p-2">No files</div>
              )}
            </div>
          )}
        </div>

        {/* File content area */}
        <div className="flex-1 min-w-0 min-h-0">
          {selectedFile && fileUrl ? (
            <div className="flex flex-col h-full">
              <div className="p-3 border-b border-white/10 flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium truncate min-w-0">
                  {selectedFile.split('/').pop()}
                </span>
                <div className="ml-auto flex items-center gap-2 shrink-0 flex-wrap justify-end">
                  <FileActions url={fileUrl} filename={selectedFile} />
                  {mode === 'inbox' && (
                    <button
                      onClick={() => moveFile(selectedFile, 'inbox', 'approved')}
                      className="px-3 py-1 text-xs bg-green-600 hover:bg-green-700 rounded text-white"
                    >
                      Approve
                    </button>
                  )}
                  {isReviewMode && mode !== 'archive' && (
                    <button
                      onClick={() => moveFile(selectedFile, mode, 'archive')}
                      className="px-3 py-1 text-xs bg-surface-overlay hover:bg-surface rounded text-text-secondary"
                    >
                      Archive
                    </button>
                  )}
                </div>
              </div>
              <div className="flex-1 overflow-auto p-4">
                <DocFileViewer url={fileUrl} filename={selectedFile} />
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-text-secondary text-sm">
              Select a file to view
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DocFileViewer({ url, filename }: { url: string; filename: string }) {
  return <FileViewer url={url} filename={filename} />;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}
