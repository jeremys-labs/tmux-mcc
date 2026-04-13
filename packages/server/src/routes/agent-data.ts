import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import type { AppConfig } from '../types/config.js';

// ---------------------------------------------------------------------------
// Helper: resolve the backing file path for a file: source tab
// ---------------------------------------------------------------------------
function resolveFileSourcePath(contentRoot: string, agentKey: string, source: string): string | null {
  if (!source.startsWith('file:')) return null;
  const fileName = source.slice(5);
  const baseName = fileName.replace(/\.[^.]+$/, '');
  const searchDirs = [
    path.join(contentRoot, 'workspace', 'agents', agentKey),
    path.join(contentRoot, 'data'),
  ];
  const candidates = [
    fileName,
    ...(fileName.endsWith('.json') ? [`${baseName}.md`] : [`${baseName}.json`]),
  ];
  for (const dir of searchDirs) {
    for (const candidate of candidates) {
      const p = path.join(dir, candidate);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export function createAgentDataRoutes(config: AppConfig, contentRoot: string): Router {
  const router = Router();

  router.get('/agent-data/:agentKey/:tabId', (req, res) => {
    const { agentKey, tabId } = req.params;
    const agent = config.agents[agentKey as string];
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

    const tab = agent.tabs.find((t) => t.id === tabId);
    if (!tab) { res.status(404).json({ error: 'Tab not found' }); return; }

    const source = tab.source;

    // ------------------------------------------------------------------
    // source: file:<name>
    // ------------------------------------------------------------------
    if (source.startsWith('file:')) {
      const fileName = source.slice(5);
      const baseName = fileName.replace(/\.[^.]+$/, '');

      // Search order: agent-specific workspace dir, then global data dir
      const searchDirs = [
        path.join(contentRoot, 'workspace', 'agents', agentKey as string),
        path.join(contentRoot, 'data'),
      ];

      // Try exact filename, then alternate extension (.md↔.json)
      const candidates = [
        fileName,
        ...(fileName.endsWith('.json') ? [`${baseName}.md`] : [`${baseName}.json`]),
      ];

      let resolved: string | null = null;
      for (const dir of searchDirs) {
        for (const candidate of candidates) {
          const p = path.join(dir, candidate);
          if (fs.existsSync(p)) { resolved = p; break; }
        }
        if (resolved) break;
      }

      if (!resolved) { res.json(null); return; }

      const ext = path.extname(resolved);
      if (ext === '.json') {
        res.json(JSON.parse(fs.readFileSync(resolved, 'utf-8')));
      } else {
        res.type('text/plain').send(fs.readFileSync(resolved, 'utf-8'));
      }
      return;
    }

    // ------------------------------------------------------------------
    // source: about
    // ------------------------------------------------------------------
    if (source === 'about') {
      const aboutPath = path.join(contentRoot, 'workspace', 'agents', agentKey as string, 'about.md');
      if (fs.existsSync(aboutPath)) {
        res.type('text/plain').send(fs.readFileSync(aboutPath, 'utf-8'));
      } else {
        // Fallback until the agent creates their about.md
        const lines = [
          `# ${agent.name}`,
          '',
          `**Role:** ${agent.role}`,
          '',
        ];
        if (agent.quote) lines.push(`> ${agent.quote}`, '');
        lines.push(`**Channel:** ${agent.channel}`);
        res.type('text/plain').send(lines.join('\n'));
      }
      return;
    }

    // ------------------------------------------------------------------
    // source: memory
    // ------------------------------------------------------------------
    if (source === 'memory') {
      const memPath = path.join(contentRoot, 'memory', 'agents', `${agentKey}.md`);
      if (fs.existsSync(memPath)) {
        res.type('text/plain').send(fs.readFileSync(memPath, 'utf-8'));
      } else {
        res.type('text/plain').send('');
      }
      return;
    }

    // ------------------------------------------------------------------
    // source: crons — proxy to /api/cron/agent/:agentKey
    // ------------------------------------------------------------------
    if (source === 'crons') {
      res.redirect(`/api/cron/agent/${agentKey}`);
      return;
    }

    res.status(400).json({ error: `Unsupported source type: ${source}` });
  });

  // ------------------------------------------------------------------
  // PATCH /api/agent-data/:agentKey/:tabId/:itemId
  // Body: { action: "complete" | "uncomplete" | "delete" }
  // Mutates the backing JSON file in-place.
  // ------------------------------------------------------------------
  router.patch('/agent-data/:agentKey/:tabId/:itemId', (req, res) => {
    const { agentKey, tabId, itemId } = req.params;
    const { action } = req.body as { action: string };

    if (!['complete', 'uncomplete', 'delete'].includes(action)) {
      res.status(400).json({ error: 'action must be complete | uncomplete | delete' });
      return;
    }

    const agent = config.agents[agentKey as string];
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

    const tab = agent.tabs.find((t) => t.id === tabId);
    if (!tab) { res.status(404).json({ error: 'Tab not found' }); return; }

    const filePath = resolveFileSourcePath(contentRoot, agentKey as string, tab.source);
    if (!filePath || !filePath.endsWith('.json')) {
      res.status(400).json({ error: 'Tab source is not a writable JSON file' });
      return;
    }

    let data: { items: Array<{ id: string; completed: boolean; completedAt: string | null; [k: string]: unknown }>; deleted?: string[] };
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      res.status(500).json({ error: 'Failed to read file' });
      return;
    }

    if (!Array.isArray(data.items)) {
      res.status(400).json({ error: 'File does not have an items array' });
      return;
    }

    const idx = data.items.findIndex((item) => item.id === itemId);
    if (idx === -1) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }

    if (action === 'delete') {
      const [removed] = data.items.splice(idx, 1);
      // Tombstone the text so the import script never re-adds this item
      if (!Array.isArray(data.deleted)) data.deleted = [];
      const normalizedText = (String(removed.text || '')).toLowerCase().trim();
      if (normalizedText && !data.deleted.includes(normalizedText)) {
        data.deleted.push(normalizedText);
      }
    } else if (action === 'complete') {
      data.items[idx].completed = true;
      data.items[idx].completedAt = new Date().toISOString();
    } else {
      data.items[idx].completed = false;
      data.items[idx].completedAt = null;
    }

    (data as Record<string, unknown>).lastUpdated = new Date().toISOString();

    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      res.status(500).json({ error: 'Failed to write file' });
      return;
    }

    res.json({ ok: true, action, itemId });
  });

  return router;
}
