import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { callOpenBrainTool, resolveOpenBrainRuntimeConfig } from './services/open-brain-runtime.js';

type SourceType = 'agent_memory' | 'imported_doc' | 'session_summary';

interface ImportItem {
  content: string;
  confidence: 'high' | 'medium';
  sourceRef: string;
  sourceType: SourceType;
}

const homeDir = process.env.HOME ?? '';
const agentsRoot = process.env.MCC_AGENTS_ROOT ?? path.join(homeDir, 'agents');
const oldOpenClawRoot = process.env.MCC_OPENCLAW_ROOT ?? path.join(homeDir, '.openclaw');
const claudeMemDb = process.env.CLAUDE_MEM_DB ?? path.join(homeDir, 'claude-mem', 'claude-mem.db');
const maxContentLength = 7000;

export function discoverAgents(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((name) => fs.existsSync(path.join(root, name, 'CLAUDE.md')))
    .sort();
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readNumberArg(name: string, fallback: number): number {
  const raw = readArg(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listFiles(root: string, predicate: (filePath: string) => boolean): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(current)) {
        if (child === 'node_modules' || child === '.git') continue;
        stack.push(path.join(current, child));
      }
    } else if (stat.isFile() && predicate(current)) {
      result.push(current);
    }
  }
  return result.sort();
}

function normalizedRef(filePath: string): string {
  return filePath
    .replace(agentsRoot, 'agents')
    .replace(oldOpenClawRoot, 'openclaw');
}

function splitContent(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxContentLength && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

function addFile(items: ImportItem[], agent: string, filePath: string): void {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return;
  const rel = normalizedRef(filePath);
  const chunks = splitContent(raw);
  chunks.forEach((chunk, index) => {
    items.push({
      sourceType: 'imported_doc',
      confidence: 'high',
      sourceRef: `history-file:${rel}${chunks.length > 1 ? `#chunk-${index + 1}` : ''}`,
      content: [
        `Imported ${agent} memory history file.`,
        `Source: ${rel}`,
        chunks.length > 1 ? `Chunk: ${index + 1} of ${chunks.length}` : '',
        '',
        chunk,
      ].filter(Boolean).join('\n'),
    });
  });
}

function currentAgentFiles(agent: string): string[] {
  const root = path.join(agentsRoot, agent);
  return listFiles(root, (filePath) => {
    if (!filePath.endsWith('.md')) return false;
    const rel = path.relative(root, filePath);
    if (rel.startsWith(`memory/agents/`) && rel !== `memory/agents/${agent}.md`) return false;
    if (rel.startsWith('memory/archive/')) return agent === 'isla' && rel.includes('isla');
    if (rel.startsWith('memory/')) {
      const memoryRel = rel.slice('memory/'.length);
      if (memoryRel === 'MEMORY.md') return true;
      if (memoryRel === `agents/${agent}.md`) return true;
      if (/^2026-\d{2}-\d{2}/.test(memoryRel)) return true;
      if (agent === 'isla' && /^daily-improvements/.test(memoryRel)) return true;
      if (agent === 'isla' && memoryRel === 'voice-research.md') return true;
      return false;
    }
    if (rel.startsWith('docs/plans/')) return true;
    return ['AGENTS.md', 'CLAUDE.md', 'BOOTSTRAP.md', 'SOUL.md', 'IDENTITY.md', 'NEWSLETTER_RULES.md', 'TOOLS.md', 'dream-log.md'].includes(rel);
  });
}

function oldAgentFiles(agent: string): string[] {
  const explicitFiles = [
    'AGENTS.md',
    'BOOTSTRAP.md',
    'HEARTBEAT.md',
    'IDENTITY.md',
    'MEMORY.md',
    'NEWSLETTER_RULES.md',
    'SOUL.md',
  ].flatMap((name) => [
    path.join(oldOpenClawRoot, `workspace-${agent}`, name),
    path.join(oldOpenClawRoot, 'agents', agent, name),
  ]);

  const oldSharedMemoryFiles = [
    path.join(oldOpenClawRoot, 'workspace', 'memory', `${agent}.md`),
    path.join(oldOpenClawRoot, 'workspace', 'memory', 'agents', `${agent}.md`),
    path.join(oldOpenClawRoot, 'workspace', 'memory', 'agents', `${agent}.backup.md`),
  ];

  const claudeProjectsRoot = path.join(homeDir, '.claude', 'projects');
  const claudeProjectRoots = [
    path.join(claudeProjectsRoot, path.join(agentsRoot, agent).replace(/\//g, '-'), 'memory'),
    path.join(claudeProjectsRoot, path.join(oldOpenClawRoot, `workspace-${agent}`).replace(/\//g, '-'), 'memory'),
  ];

  const claudeFiles = claudeProjectRoots.flatMap((root) => listFiles(root, (filePath) => {
    if (!filePath.endsWith('.md')) return false;
    const rel = path.relative(root, filePath);
    if (rel.startsWith('memory/agents/') && rel !== `memory/agents/${agent}.md`) return false;
    return true;
  }));

  return [...explicitFiles, ...oldSharedMemoryFiles, ...claudeFiles]
    .filter((filePath) => fs.existsSync(filePath));
}

function addFactDb(items: ImportItem[], agent: string, dbPath: string, seenFacts: Set<string>): void {
  if (!fs.existsSync(dbPath)) return;
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(`
    select agent_id, category, key, value, data_type, tags, source, confidence, created_at, updated_at
    from facts
    where agent_id = ?
    order by category, key, created_at
  `).all(agent) as Array<Record<string, unknown>>;
  db.close();

  const uniqueRows = rows.filter((row) => {
    const key = JSON.stringify([row.agent_id, row.category, row.key, row.value]);
    if (seenFacts.has(key)) return false;
    seenFacts.add(key);
    return true;
  });

  for (let index = 0; index < uniqueRows.length; index += 80) {
    const batch = uniqueRows.slice(index, index + 80);
    if (batch.length === 0) continue;
    items.push({
      sourceType: 'agent_memory',
      confidence: 'high',
      sourceRef: `history-facts:${normalizedRef(dbPath)}#${agent}-${Math.floor(index / 80) + 1}`,
      content: [
        `Imported structured ${agent} fact memory.`,
        `Source: ${normalizedRef(dbPath)}`,
        '',
        ...batch.map((row) => [
          `- ${String(row.category)}.${String(row.key)}: ${String(row.value)}`,
          row.tags ? `  Tags: ${String(row.tags)}` : '',
          row.source ? `  Original source: ${String(row.source)}` : '',
          row.created_at ? `  Created: ${String(row.created_at)}` : '',
        ].filter(Boolean).join('\n')),
      ].join('\n'),
    });
  }
}

function addChunkDb(items: ImportItem[], agent: string, dbPath: string): void {
  if (!fs.existsSync(dbPath)) return;
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(`
    select path, start_line, end_line, text
    from chunks
    order by path, start_line
  `).all() as Array<{ path: string; start_line: number; end_line: number; text: string }>;
  db.close();

  const allowed = rows.filter((row) => {
    if (row.path.startsWith('memory/agents/') && row.path !== `memory/agents/${agent}.md`) return false;
    if (row.path.startsWith('memory/')) {
      const memoryPath = row.path.slice('memory/'.length);
      if (memoryPath === `agents/${agent}.md`) return true;
      if (/^2026-\d{2}-\d{2}/.test(memoryPath)) return true;
      return false;
    }
    return true;
  });

  const byPath = new Map<string, typeof allowed>();
  for (const row of allowed) {
    const current = byPath.get(row.path) ?? [];
    current.push(row);
    byPath.set(row.path, current);
  }

  for (const [sourcePath, pathRows] of byPath.entries()) {
    const content = pathRows
      .map((row) => `Lines ${row.start_line}-${row.end_line}:\n${row.text.trim()}`)
      .join('\n\n')
      .trim();
    if (!content) continue;
    splitContent(content).forEach((chunk, index, chunks) => {
      items.push({
        sourceType: 'imported_doc',
        confidence: 'medium',
        sourceRef: `history-chunks:${normalizedRef(dbPath)}:${sourcePath}${chunks.length > 1 ? `#chunk-${index + 1}` : ''}`,
        content: [
          `Imported ${agent} old vector-index memory chunks.`,
          `Source DB: ${normalizedRef(dbPath)}`,
          `Source path: ${sourcePath}`,
          chunks.length > 1 ? `Chunk: ${index + 1} of ${chunks.length}` : '',
          '',
          chunk,
        ].filter(Boolean).join('\n'),
      });
    });
  }
}

function addClaudeMem(items: ImportItem[], agent: string): void {
  if (!fs.existsSync(claudeMemDb)) return;
  const db = new Database(claudeMemDb, { readonly: true });
  const observations = db.prepare(`
    select id, type, title, subtitle, facts, narrative, concepts, text, created_at
    from observations
    where project = ?
    order by created_at, id
  `).all(agent) as Array<Record<string, unknown>>;
  const summaries = db.prepare(`
    select id, request, investigated, learned, completed, next_steps, notes, created_at
    from session_summaries
    where project = ?
    order by created_at, id
  `).all(agent) as Array<Record<string, unknown>>;
  db.close();

  const observationGroups = new Map<string, typeof observations>();
  for (const row of observations) {
    const date = String(row.created_at).slice(0, 10);
    const key = `${date}:${String(row.type)}`;
    const current = observationGroups.get(key) ?? [];
    current.push(row);
    observationGroups.set(key, current);
  }

  for (const [key, rows] of observationGroups.entries()) {
    for (let index = 0; index < rows.length; index += 20) {
      const batch = rows.slice(index, index + 20);
      const baseRef = `claude-mem:observations:${agent}:${key}:batch-${Math.floor(index / 20) + 1}`;
      const content = [
        `Imported claude-mem observations for ${agent}.`,
        `Group: ${key}`,
        '',
        ...batch.map((row) => [
          `Observation ${String(row.id)} (${String(row.created_at)}, ${String(row.type)})`,
          row.title ? `Title: ${String(row.title)}` : '',
          row.subtitle ? `Subtitle: ${String(row.subtitle)}` : '',
          row.narrative ? `Narrative: ${String(row.narrative)}` : '',
          row.facts ? `Facts: ${String(row.facts)}` : '',
          row.concepts ? `Concepts: ${String(row.concepts)}` : '',
          row.text ? `Text: ${String(row.text)}` : '',
        ].filter(Boolean).join('\n')),
      ].join('\n\n');

      splitContent(content).forEach((chunk, chunkIndex, chunks) => {
        items.push({
          sourceType: 'imported_doc',
          confidence: 'medium',
          sourceRef: `${baseRef}${chunks.length > 1 ? `#chunk-${chunkIndex + 1}` : ''}`,
          content: chunk,
        });
      });
    }
  }

  for (let index = 0; index < summaries.length; index += 20) {
    const batch = summaries.slice(index, index + 20);
    const baseRef = `claude-mem:session_summaries:${agent}:batch-${Math.floor(index / 20) + 1}`;
    const content = [
      `Imported claude-mem session summaries for ${agent}.`,
      '',
      ...batch.map((row) => [
        `Session summary ${String(row.id)} (${String(row.created_at)})`,
        row.request ? `Request: ${String(row.request)}` : '',
        row.investigated ? `Investigated: ${String(row.investigated)}` : '',
        row.learned ? `Learned: ${String(row.learned)}` : '',
        row.completed ? `Completed: ${String(row.completed)}` : '',
        row.next_steps ? `Next steps: ${String(row.next_steps)}` : '',
        row.notes ? `Notes: ${String(row.notes)}` : '',
      ].filter(Boolean).join('\n')),
    ].join('\n\n');

    splitContent(content).forEach((chunk, chunkIndex, chunks) => {
      items.push({
        sourceType: 'session_summary',
        confidence: 'medium',
        sourceRef: `${baseRef}${chunks.length > 1 ? `#chunk-${chunkIndex + 1}` : ''}`,
        content: chunk,
      });
    });
  }
}

function buildItems(agent: string): ImportItem[] {
  const items: ImportItem[] = [];
  const seenFiles = new Set<string>();
  const seenFacts = new Set<string>();

  for (const filePath of [...currentAgentFiles(agent), ...oldAgentFiles(agent)]) {
    const realPath = fs.realpathSync(filePath);
    if (seenFiles.has(realPath)) continue;
    seenFiles.add(realPath);
    addFile(items, agent, realPath);
  }

  addFactDb(items, agent, path.join(agentsRoot, agent, 'memory', 'agent_memory.db'), seenFacts);
  addFactDb(items, agent, path.join(oldOpenClawRoot, 'workspace', 'memory', 'agent_memory.db'), seenFacts);
  addChunkDb(items, agent, path.join(oldOpenClawRoot, 'memory', `${agent}.sqlite`));
  addChunkDb(items, agent, path.join(agentsRoot, agent, 'memory', `${agent}.sqlite`));
  addClaudeMem(items, agent);

  const seenContent = new Set<string>();
  return items.filter((item) => {
    const hash = crypto.createHash('sha256').update(`${item.sourceType}\n${item.sourceRef}\n${item.content}`).digest('hex');
    if (seenContent.has(hash)) return false;
    seenContent.add(hash);
    return true;
  });
}

async function main(): Promise<void> {
  const agent = readArg('--agent');
  const knownAgents = discoverAgents(agentsRoot);
  const agentDir = agent ? path.join(agentsRoot, agent) : '';
  if (!agent || !fs.existsSync(path.join(agentDir, 'CLAUDE.md'))) {
    const agentList = knownAgents.length > 0 ? knownAgents.join('|') : '<agent-name>';
    throw new Error(`Usage: open-brain-seed-agent-history --agent ${agentList} [--dry-run]`);
  }

  const dryRun = hasFlag('--dry-run');
  const start = readNumberArg('--start', 1);
  const end = readNumberArg('--end', Number.MAX_SAFE_INTEGER);
  const delayMs = readNumberArg('--delay-ms', 1);
  const continueOnError = hasFlag('--continue-on-error');
  const allItems = buildItems(agent);
  const items = allItems
    .map((item, index) => ({ item, index: index + 1 }))
    .filter(({ index }) => index >= start && index <= end);
  const config = resolveOpenBrainRuntimeConfig(agent);
  if (!config) throw new Error(`No Open Brain runtime config for ${agent}`);

  process.stdout.write(`Prepared ${allItems.length} ${agent} history import item(s); selected ${items.length} item(s) (${start}-${Math.min(end, allItems.length)}).\n`);
  const byType = new Map<string, number>();
  for (const { item } of items) byType.set(item.sourceType, (byType.get(item.sourceType) ?? 0) + 1);
  for (const [type, count] of [...byType.entries()].sort()) {
    process.stdout.write(`- ${type}: ${count}\n`);
  }

  if (dryRun) {
    for (const { item, index } of items.slice(0, 80)) {
      process.stdout.write(`DRY #${index} ${item.sourceType} ${item.sourceRef} (${item.content.length} chars)\n`);
    }
    return;
  }

  let imported = 0;
  const errors: string[] = [];
  for (const { item, index } of items) {
    try {
      await callOpenBrainTool(config, 'capture_agent_memory', {
        agent_id: agent,
        scope: 'private_agent',
        project: 'agent-history',
        audience: [agent],
        authority: 'context',
        confidence: item.confidence,
        source_type: item.sourceType,
        source_ref: item.sourceRef,
        content: item.content,
      });
      imported += 1;
      if (imported % 25 === 0) {
        process.stdout.write(`Imported ${imported}/${items.length} selected ${agent} history item(s); latest #${index}.\n`);
      }
      if (delayMs > 1) await sleep(delayMs);
    } catch (error) {
      const message = `Failed #${index} ${item.sourceType} ${item.sourceRef}: ${error instanceof Error ? error.message : String(error)}`;
      process.stderr.write(`${message}\n`);
      errors.push(message);
      if (!continueOnError) throw error;
    }
  }

  process.stdout.write(`Imported ${imported}/${items.length} selected ${agent} history item(s).\n`);
  if (errors.length > 0) {
    process.stdout.write(`Skipped ${errors.length} failed item(s):\n${errors.join('\n')}\n`);
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
