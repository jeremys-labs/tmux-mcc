import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import {
  callOpenBrainTool,
  type OpenBrainRuntimeConfig,
} from './open-brain-runtime.js';

const DEFAULT_AGENTS_ROOT = '/Volumes/Repo-Drive/agents';

export type InboundTurnSource = 'discord' | 'agent_mail' | 'claude_prompt';

export interface BuildAnswerContextInput {
  agentKey: string;
  source: InboundTurnSource;
  text: string;
  subject?: string;
  project?: string | null;
  openBrainConfig?: OpenBrainRuntimeConfig | null;
  agentsRoot?: string;
  now?: Date;
}

interface DomainContext {
  domain: string;
  content: string;
}

function compactText(value: string, maxLength = 2400): string {
  const text = value.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trim()}...`;
}

function readFileIfExists(filePath: string, maxLength = 2400): string {
  try {
    return compactText(fs.readFileSync(filePath, 'utf8'), maxLength);
  } catch {
    return '';
  }
}

function matchingLines(text: string, patterns: RegExp[], contextRadius = 1, maxLength = 1400): string {
  const lines = text.split(/\r?\n/);
  const selected = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    if (!patterns.some((pattern) => pattern.test(lines[index]))) continue;
    for (let cursor = Math.max(0, index - contextRadius); cursor <= Math.min(lines.length - 1, index + contextRadius); cursor += 1) {
      selected.add(cursor);
    }
  }
  return compactText([...selected].sort((a, b) => a - b).map((index) => lines[index]).join('\n'), maxLength);
}

function safeJsonFile(filePath: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function isoDateInNewYork(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function hasAny(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function shouldLoadRemyContext(agentKey: string, text: string): boolean {
  return agentKey === 'remy' && hasAny(text, [
    'breakfast',
    'lunch',
    'dinner',
    'meal',
    'recipe',
    'cook',
    'cooking',
    'food',
    'grocery',
    'groceries',
    'ingredient',
    'eat',
    'make',
    'making',
    'menu',
  ]);
}

function shouldLoadLenaContext(agentKey: string, text: string): boolean {
  return agentKey === 'lena' && hasAny(text, [
    'weigh',
    'weight',
    'workout',
    'worked out',
    'gym',
    'lift',
    'cardio',
    'run',
    'training',
    'rpe',
    'tirzepatide',
  ]);
}

function latestRows(dbPath: string, sql: string, params: unknown[] = []): Array<Record<string, unknown>> {
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function formatRows(rows: Array<Record<string, unknown>>): string {
  return rows
    .map((row) => Object.entries(row)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(', '))
    .join('\n');
}

function findIngredientFile(remyRoot: string, dateIso: string): string | null {
  const dir = path.join(remyRoot, 'ingredients');
  if (!fs.existsSync(dir)) return null;
  const match = fs.readdirSync(dir)
    .filter((name) => name.startsWith(dateIso) && name.endsWith('.json'))
    .sort()[0];
  return match ? path.join(dir, match) : null;
}

function buildRemyContext(text: string, agentsRoot: string, now: Date): DomainContext | null {
  const remyRoot = path.join(agentsRoot, 'remy');
  const today = isoDateInNewYork(now);
  const tomorrow = isoDateInNewYork(addDays(now, 1));
  const mealPlan = readFileIfExists(path.join(remyRoot, 'mealplan.md'), 1800);
  const todayRecipe = findIngredientFile(remyRoot, today);
  const tomorrowRecipe = findIngredientFile(remyRoot, tomorrow);
  const sections = [
    mealPlan ? `Current meal plan:\n${mealPlan}` : '',
    todayRecipe ? `Today's recipe/ingredient state (${today}):\n${readFileIfExists(todayRecipe, 1600)}` : '',
    tomorrowRecipe ? `Tomorrow's recipe/ingredient state (${tomorrow}):\n${readFileIfExists(tomorrowRecipe, 1200)}` : '',
  ].filter(Boolean);
  if (sections.length === 0) return null;
  return {
    domain: 'food',
    content: sections.join('\n\n'),
  };
}

function buildLenaContext(text: string, agentsRoot: string): DomainContext | null {
  const lenaRoot = path.join(agentsRoot, 'lena');
  const memoryPath = path.join(lenaRoot, 'memory', 'agents', 'lena.md');
  const fullMemory = readFileIfExists(memoryPath, 16000);
  const activeState = matchingLines(fullMemory, [
    /last completed/i,
    /next workout/i,
    /current state/i,
    /rotation/i,
    /not completed/i,
  ], 2, 1800);
  const memory = compactText(fullMemory, 2000);
  const weightRows = latestRows(
    path.join(lenaRoot, 'weight.db'),
    'select date, weight_lbs, notes, recorded_at from weigh_ins order by date desc limit 7',
  );
  const workoutRows = latestRows(
    path.join(lenaRoot, 'memory', 'agent_memory.db'),
    "select metric_key, value, context, timestamp from metrics where agent_id = 'lena' and metric_key like 'workout%' order by timestamp desc limit 8",
  );
  const sections = [
    weightRows.length ? `Recent weigh-ins:\n${formatRows(weightRows)}` : '',
    workoutRows.length ? `Recent workout metrics:\n${formatRows(workoutRows)}` : '',
    activeState ? `Lena active workout state:\n${activeState}` : '',
    memory ? `Lena active memory excerpt:\n${memory}` : '',
  ].filter(Boolean);
  if (sections.length === 0) return null;
  return {
    domain: 'fitness',
    content: sections.join('\n\n'),
  };
}

function buildDomainContexts(agentKey: string, text: string, agentsRoot: string, now: Date): DomainContext[] {
  const contexts: DomainContext[] = [];
  if (shouldLoadRemyContext(agentKey, text)) {
    const context = buildRemyContext(text, agentsRoot, now);
    if (context) contexts.push(context);
  }
  if (shouldLoadLenaContext(agentKey, text)) {
    const context = buildLenaContext(text, agentsRoot);
    if (context) contexts.push(context);
  }
  return contexts;
}

function buildMemoryQuery(input: BuildAnswerContextInput): string {
  return [
    input.subject ? `Subject: ${input.subject}` : '',
    input.project ? `Project: ${input.project}` : '',
    input.text,
    'current source-of-truth preferences recent relevant state before answering',
  ].filter(Boolean).join('\n');
}

async function searchAnswerMemory(input: BuildAnswerContextInput): Promise<string> {
  if (!input.openBrainConfig) return '';
  const result = await callOpenBrainTool(input.openBrainConfig, 'search_agent_memory', {
    agent_id: input.openBrainConfig.agentId,
    query: buildMemoryQuery(input),
    project: input.project ?? undefined,
    limit: 6,
    threshold: 0.1,
  });
  return compactText(result.text, 3600);
}

export function formatAnswerContext(input: {
  agentKey: string;
  source: InboundTurnSource;
  memoryText?: string;
  domainContexts?: DomainContext[];
}): string {
  const sections: string[] = [];
  const memoryText = input.memoryText?.trim();
  if (memoryText) {
    sections.push([
      '<governed_memory>',
      memoryText,
      '</governed_memory>',
    ].join('\n'));
  }

  for (const context of input.domainContexts ?? []) {
    sections.push([
      `<domain_state domain="${context.domain}">`,
      compactText(context.content, 4200),
      '</domain_state>',
    ].join('\n'));
  }

  if (sections.length === 0) return '';
  return [
    `[Answer Context] Retrieved before ${input.source} turn for ${input.agentKey}.`,
    '',
    '<answer_context>',
    ...sections,
    '</answer_context>',
    '',
    'Use this context before answering. Do not ask Jeremy for information that is present here. Current domain_state and shared_team/source_of_truth memory outrank stale imported history.',
  ].join('\n');
}

export async function buildAnswerContext(input: BuildAnswerContextInput): Promise<string> {
  const agentsRoot = input.agentsRoot ?? process.env.AGENTS_ROOT ?? DEFAULT_AGENTS_ROOT;
  const now = input.now ?? new Date();
  const [memoryText, domainContexts] = await Promise.all([
    searchAnswerMemory(input),
    Promise.resolve(buildDomainContexts(input.agentKey, input.text, agentsRoot, now)),
  ]);
  return formatAnswerContext({
    agentKey: input.agentKey,
    source: input.source,
    memoryText,
    domainContexts,
  });
}
