import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';

interface Props {
  url: string;
  filename: string;
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
const TEXT_EXTS = ['md', 'txt', 'json', 'csv', 'log', 'yaml', 'yml', 'toml', 'env', 'sh', 'py', 'js', 'ts', 'tsx', 'jsx'];
const BINARY_DOWNLOAD_EXTS = ['pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls', 'zip', 'tar', 'gz'];

function DownloadCard({ url, filename }: { url: string; filename: string }) {
  const ext = filename.split('.').pop()?.toUpperCase() || 'FILE';
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 py-16">
      <div className="text-5xl opacity-40">📄</div>
      <p className="text-text-secondary text-sm">{ext} files can't be previewed in the browser.</p>
      <a
        href={url}
        download={filename}
        className="px-4 py-2 rounded bg-accent text-white text-sm font-medium hover:opacity-80 transition-opacity"
      >
        Download {filename}
      </a>
    </div>
  );
}

export function FileViewer({ url, filename }: Props) {
  const [content, setContent] = useState<string>('');
  const ext = filename.split('.').pop()?.toLowerCase() || '';

  const needsTextFetch = TEXT_EXTS.includes(ext) || (!IMAGE_EXTS.includes(ext) && ext !== 'pdf' && ext !== 'html' && ext !== 'htm' && !BINARY_DOWNLOAD_EXTS.includes(ext));

  useEffect(() => {
    if (!needsTextFetch) return;
    fetch(url)
      .then((r) => r.text())
      .then(setContent);
  }, [url, needsTextFetch]);

  // Images
  if (IMAGE_EXTS.includes(ext)) {
    return <img src={url} alt={filename} className="max-w-full" />;
  }

  // PDF — native browser renderer via iframe
  if (ext === 'pdf') {
    return (
      <iframe
        src={url}
        className="w-full border-0 rounded"
        style={{ height: '100%', minHeight: '700px' }}
        title={filename}
      />
    );
  }

  // HTML — sandboxed iframe
  if (ext === 'html' || ext === 'htm') {
    return (
      <iframe
        srcDoc={content}
        sandbox="allow-scripts allow-same-origin"
        className="w-full border-0 rounded"
        style={{ height: '100%', minHeight: '600px' }}
        title={filename}
      />
    );
  }

  // Binary formats — download only
  if (BINARY_DOWNLOAD_EXTS.includes(ext)) {
    return <DownloadCard url={url} filename={filename} />;
  }

  // Markdown
  if (ext === 'md') {
    return (
      <div className="prose prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkFrontmatter]}>{content}</ReactMarkdown>
      </div>
    );
  }

  // JSON — pretty-printed
  if (ext === 'json') {
    try {
      const formatted = JSON.stringify(JSON.parse(content), null, 2);
      return <pre className="text-xs text-text-primary font-mono whitespace-pre-wrap">{formatted}</pre>;
    } catch {
      return <pre className="text-xs text-text-primary font-mono whitespace-pre-wrap">{content}</pre>;
    }
  }

  // Plain text / code / everything else
  return <pre className="text-xs text-text-primary font-mono whitespace-pre-wrap">{content}</pre>;
}
