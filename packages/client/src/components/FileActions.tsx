import { useCallback, useState } from 'react';

interface Props {
  url: string;
  filename: string;
  /** Raw text content if already fetched (avoids double-fetch) */
  content?: string;
}

function getFileMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    html: 'text/html',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };
  return map[ext] || 'application/octet-stream';
}

function isTextFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return ['md', 'txt', 'json', 'html', 'ts', 'tsx', 'js', 'jsx', 'py', 'sh', 'yaml', 'yml', 'toml', 'csv'].includes(ext);
}

const PRINT_FRAME_ID = 'mcc-print-frame';
const PRINT_STYLE_ID = 'mcc-print-styles';

/**
 * In-page print without pop-ups — works in iOS Safari PWA.
 *
 * Strategy:
 *  1. Fetch file content
 *  2. Hide the React root via JS (display:none) — more reliable than
 *     @media print selectors fighting Tailwind's dark theme
 *  3. Force html+body to white/black with a <style> tag that uses
 *     -webkit-print-color-adjust: exact so iOS doesn't apply its own tint
 *  4. Append a normal-flow <div> (NOT position:fixed) with the content —
 *     normal flow lets iOS paginate across multiple pages properly
 *  5. window.print() — shows AirPrint sheet
 *  6. Restore everything on afterprint (+ 30s safety fallback)
 */
async function inPagePrint(url: string, filename: string, content?: string) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const isMono = ['json', 'ts', 'tsx', 'js', 'jsx', 'py', 'sh', 'yaml', 'yml', 'toml', 'csv'].includes(ext);

  // 1. Fetch content
  let text = content;
  if (!text) {
    try {
      const res = await fetch(url);
      text = await res.text();
    } catch {
      text = '(Unable to load file content)';
    }
  }

  const escapedContent = (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 2. Hide the app root(s) by toggling display in JS
  const appRoots = Array.from(document.body.children) as HTMLElement[];
  const prevDisplays = appRoots.map((el) => el.style.display);
  appRoots.forEach((el) => { el.style.display = 'none'; });

  // 3. Force html/body to white — override Tailwind dark theme
  const styleEl = document.createElement('style');
  styleEl.id = PRINT_STYLE_ID;
  styleEl.textContent = `
    html, body {
      background: #ffffff !important;
      color: #000000 !important;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    #${PRINT_FRAME_ID} {
      background: #ffffff !important;
      color: #000000 !important;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      font-size: 12pt;
      line-height: 1.65;
      padding: 0;
      margin: 0;
      width: 100%;
    }
    #${PRINT_FRAME_ID} .pf-filename {
      font-size: 9pt;
      color: #555555;
      border-bottom: 1pt solid #cccccc;
      padding-bottom: 6pt;
      margin-bottom: 14pt;
    }
    #${PRINT_FRAME_ID} .pf-body {
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: break-word;
      font-family: ${isMono ? "'Courier New', 'Courier', monospace" : 'inherit'};
      font-size: ${isMono ? '10pt' : '12pt'};
      color: #000000 !important;
      background: transparent !important;
    }
  `;
  document.head.appendChild(styleEl);

  // 4. Append content as normal-flow div (NOT fixed — lets iOS paginate)
  const frameEl = document.createElement('div');
  frameEl.id = PRINT_FRAME_ID;
  frameEl.innerHTML = `
    <div class="pf-filename">${filename}</div>
    <div class="pf-body">${escapedContent}</div>
  `;
  document.body.appendChild(frameEl);

  // Give browser a paint cycle to apply styles before printing
  await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 80)));

  // 5. Print
  window.print();

  // 6. Restore
  const cleanup = () => {
    appRoots.forEach((el, i) => { el.style.display = prevDisplays[i]; });
    document.getElementById(PRINT_STYLE_ID)?.remove();
    document.getElementById(PRINT_FRAME_ID)?.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  // Safety fallback — afterprint may not fire on all iOS versions
  setTimeout(cleanup, 60_000);
}

export function FileActions({ url, filename, content }: Props) {
  const [printing, setPrinting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const isPdf = ext === 'pdf';

  // --- Print ---
  const handlePrint = useCallback(async () => {
    setPrinting(true);
    setActionError(null);
    try {
      if (isPdf) {
        // PDFs: share via native sheet on mobile (AirPrint), or open new tab on desktop
        if (canShare) {
          const res = await fetch(url);
          const blob = await res.blob();
          const file = new File([blob], filename, { type: 'application/pdf' });
          if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: filename });
          } else {
            window.open(url, '_blank');
          }
        } else {
          window.open(url, '_blank');
        }
      } else {
        await inPagePrint(url, filename, content);
      }
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setActionError('Print failed');
        setTimeout(() => setActionError(null), 3000);
      }
    } finally {
      setPrinting(false);
    }
  }, [url, filename, content, isPdf, canShare]);

  // --- Share ---
  const handleShare = useCallback(async () => {
    setSharing(true);
    setActionError(null);

    try {
      const mimeType = getFileMimeType(filename);
      let blob: Blob;

      if (isTextFile(filename) && content) {
        blob = new Blob([content], { type: mimeType });
      } else {
        const res = await fetch(url);
        blob = await res.blob();
      }

      const file = new File([blob], filename, { type: mimeType });

      // Try sharing as a file first (iOS/iPad share sheet → iMessage, AirDrop, etc.)
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
      } else if (isTextFile(filename)) {
        // Fallback: share as text
        const text = content || await (await fetch(url)).text();
        await navigator.share({ title: filename, text });
      } else {
        triggerDownload(blob, filename);
      }
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setActionError('Share failed');
        setTimeout(() => setActionError(null), 3000);
      }
    } finally {
      setSharing(false);
    }
  }, [url, filename, content]);

  // --- Download (desktop fallback) ---
  const handleDownload = useCallback(async () => {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      triggerDownload(blob, filename);
    } catch {
      setActionError('Download failed');
      setTimeout(() => setActionError(null), 3000);
    }
  }, [url, filename]);

  return (
    <div className="flex items-center gap-1.5">
      {/* Share — native share sheet on iOS/iPad */}
      {canShare ? (
        <button
          onClick={handleShare}
          disabled={sharing}
          className="flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-surface-overlay hover:bg-surface text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
          title="Share via iMessage, AirDrop, etc."
        >
          <ShareIcon />
          {sharing ? 'Sharing…' : 'Share'}
        </button>
      ) : (
        /* Desktop: download instead */
        <button
          onClick={handleDownload}
          className="flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-surface-overlay hover:bg-surface text-text-secondary hover:text-text-primary transition-colors"
          title="Download file"
        >
          <DownloadIcon />
          Download
        </button>
      )}

      {/* Print */}
      <button
        onClick={handlePrint}
        disabled={printing}
        className="flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-surface-overlay hover:bg-surface text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
        title={isPdf ? 'Share PDF for printing' : 'Print file'}
      >
        <PrintIcon />
        {printing ? 'Loading…' : 'Print'}
      </button>

      {actionError && (
        <span className="text-xs text-red-400">{actionError}</span>
      )}
    </div>
  );
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ShareIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
    </svg>
  );
}

function PrintIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>
  );
}
