import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import {
  callOpenBrainTool,
  type OpenBrainRuntimeConfig,
} from './open-brain-runtime.js';

const DEFAULT_AGENTS_ROOT = '/Volumes/Repo-Drive/agents';
const DEFAULT_OPEN_BRAIN_ENV_PATH = '/Volumes/Repo-Drive/src/open-brain/credentials/ob1.env';
const DEFAULT_SCHEDULED_DISCORD_OUTBOX_PATH = '/Volumes/Repo-Drive/agents/SHARED/scheduled-discord-outbox.jsonl';

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

interface ScheduledDiscordOutboxRecord {
  timestamp?: string;
  job_id?: string;
  label?: string;
  agent?: string;
  chat_ids?: string[];
  prompt_excerpt?: string;
}

interface OpenBrainRestConfig {
  projectUrl: string;
  serviceRoleKey: string;
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

function parseDiscordChatId(text: string): string {
  const channelMatch = text.match(/<channel\b[^>]*\bchat_id="([^"]+)"/);
  if (channelMatch) return channelMatch[1];
  const explicitMatch = text.match(/\bChat ID:\s*(\d{10,25})\b/i);
  return explicitMatch?.[1] ?? '';
}

function readScheduledDiscordOutbox(
  agentKey: string,
  chatId: string,
  now: Date,
  filePath = process.env.SCHEDULED_DISCORD_OUTBOX_PATH ?? DEFAULT_SCHEDULED_DISCORD_OUTBOX_PATH,
): ScheduledDiscordOutboxRecord[] {
  if (!chatId) return [];
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as ScheduledDiscordOutboxRecord;
      } catch {
        return null;
      }
    })
    .filter((record): record is ScheduledDiscordOutboxRecord => Boolean(record))
    .filter((record) => record.agent === agentKey)
    .filter((record) => Array.isArray(record.chat_ids) && record.chat_ids.includes(chatId))
    .filter((record) => {
      if (!record.timestamp) return false;
      const ts = new Date(record.timestamp).getTime();
      return Number.isFinite(ts) && now.getTime() - ts <= maxAgeMs;
    })
    .slice(-5)
    .reverse();
}

function formatScheduledDiscordOutbox(records: ScheduledDiscordOutboxRecord[]): string {
  if (records.length === 0) return '';
  return records.map((record) => [
    `time=${record.timestamp ?? 'unknown'}`,
    `job=${record.label ?? record.job_id ?? 'unknown'}`,
    `job_id=${record.job_id ?? 'unknown'}`,
    `scheduled_prompt=${compactText(record.prompt_excerpt ?? '', 900)}`,
  ].join('\n')).join('\n\n');
}

function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function resolveOpenBrainRestConfig(): OpenBrainRestConfig | null {
  if (process.env.OPEN_BRAIN_EXTENSION_CONTEXT_DISABLED === '1') return null;
  const projectUrl = process.env.SUPABASE_PROJECT_URL;
  const serviceRoleKey = process.env.SUPABASE_SECRET_KEY;
  if (projectUrl && serviceRoleKey) return { projectUrl, serviceRoleKey };

  const envPath = process.env.OPEN_BRAIN_ENV_PATH ?? DEFAULT_OPEN_BRAIN_ENV_PATH;
  try {
    const env = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
    if (!env.SUPABASE_PROJECT_URL || !env.SUPABASE_SECRET_KEY) return null;
    return {
      projectUrl: env.SUPABASE_PROJECT_URL,
      serviceRoleKey: env.SUPABASE_SECRET_KEY,
    };
  } catch {
    return null;
  }
}

async function openBrainRestRows<T>(config: OpenBrainRestConfig, pathAndQuery: string): Promise<T[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const url = new URL(`/rest/v1/${pathAndQuery}`, config.projectUrl);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
      },
    });
    if (!response.ok) return [];
    const parsed = await response.json() as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
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

interface MealPlanRow {
  meal_date?: string | null;
  day_of_week?: string | null;
  meal_type?: string | null;
  custom_meal?: string | null;
  status?: string | null;
  servings?: number | null;
  notes?: string | null;
  recipe_id?: string | null;
  source_ref?: string | null;
}

interface RecipeRow {
  id?: string | null;
  name?: string | null;
  recipe_date?: string | null;
  ingredients?: unknown;
  cook_time_minutes?: number | null;
  notes?: string | null;
  source_ref?: string | null;
}

async function buildRemyExtensionContext(now: Date): Promise<DomainContext | null> {
  const config = resolveOpenBrainRestConfig();
  if (!config) return null;
  const today = isoDateInNewYork(now);
  const tomorrow = isoDateInNewYork(addDays(now, 1));
  const dateList = [today, tomorrow].map((date) => `"${date}"`).join(',');
  const [mealRows, recipeRows] = await Promise.all([
    openBrainRestRows<MealPlanRow>(
      config,
      `meal_plans?select=meal_date,day_of_week,meal_type,custom_meal,status,servings,notes,recipe_id,source_ref&agent_id=eq.remy&meal_date=in.(${dateList})&order=meal_date.asc`,
    ),
    openBrainRestRows<RecipeRow>(
      config,
      `recipes?select=id,name,recipe_date,ingredients,cook_time_minutes,notes,source_ref&agent_id=eq.remy&recipe_date=in.(${dateList})&order=recipe_date.asc`,
    ),
  ]);
  if (!mealRows.length && !recipeRows.length) return null;

  const recipesById = new Map(recipeRows.map((row) => [row.id, row]));
  const recipeByDate = new Map(recipeRows.map((row) => [row.recipe_date, row]));
  const meals = mealRows.map((row) => {
    const recipe = (row.recipe_id ? recipesById.get(row.recipe_id) : null) ?? recipeByDate.get(row.meal_date ?? '');
    return [
      `${row.meal_date} ${row.meal_type ?? 'meal'}: ${row.custom_meal ?? recipe?.name ?? 'planned meal'}`,
      row.status ? `status=${row.status}` : '',
      row.servings ? `servings=${row.servings}` : '',
      row.notes ? `notes=${row.notes}` : '',
      recipe?.source_ref ? `recipe_source=${recipe.source_ref}` : '',
    ].filter(Boolean).join(', ');
  });
  const recipes = recipeRows.map((row) => [
    `${row.recipe_date}: ${row.name}`,
    row.cook_time_minutes ? `cook_time_minutes=${row.cook_time_minutes}` : '',
    Array.isArray(row.ingredients) ? `ingredients=${row.ingredients.length}` : '',
    row.notes ? `notes=${row.notes}` : '',
    row.source_ref ? `source=${row.source_ref}` : '',
  ].filter(Boolean).join(', '));

  return {
    domain: 'food',
    content: [
      meals.length ? `Meal-planning extension current rows:\n${meals.join('\n')}` : '',
      recipes.length ? `Meal-planning extension recipe rows:\n${recipes.join('\n')}` : '',
    ].filter(Boolean).join('\n\n'),
  };
}

function buildRemyFileContext(text: string, agentsRoot: string, now: Date): DomainContext | null {
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

interface FitnessTrainingStateRow {
  state_key?: string | null;
  state?: unknown;
  source_ref?: string | null;
}

interface FitnessWeighInRow {
  weigh_in_date?: string | null;
  weight_lbs?: number | null;
  notes?: string | null;
  recorded_at?: string | null;
}

interface FitnessWorkoutRow {
  workout_date?: string | null;
  workout_type?: string | null;
  status?: string | null;
  metrics?: unknown;
  rpe?: number | null;
  notes?: string | null;
  source_ref?: string | null;
}

function stringifyUnknown(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function buildLenaExtensionContext(): Promise<DomainContext | null> {
  const config = resolveOpenBrainRestConfig();
  if (!config) return null;
  const [stateRows, weightRows, workoutRows] = await Promise.all([
    openBrainRestRows<FitnessTrainingStateRow>(
      config,
      'fitness_training_state?select=state_key,state,source_ref&agent_id=eq.lena&state_key=eq.current_rotation&limit=1',
    ),
    openBrainRestRows<FitnessWeighInRow>(
      config,
      'fitness_weigh_ins?select=weigh_in_date,weight_lbs,notes,recorded_at&agent_id=eq.lena&order=weigh_in_date.desc&limit=7',
    ),
    openBrainRestRows<FitnessWorkoutRow>(
      config,
      'fitness_workouts?select=workout_date,workout_type,status,metrics,rpe,notes,source_ref&agent_id=eq.lena&order=workout_date.desc.nullslast&limit=8',
    ),
  ]);
  if (!stateRows.length && !weightRows.length && !workoutRows.length) return null;

  const sections = [
    stateRows.length ? `Fitness extension current training state:\n${stateRows.map((row) => [
      row.state_key ? `state_key=${row.state_key}` : '',
      stringifyUnknown(row.state),
      row.source_ref ? `source=${row.source_ref}` : '',
    ].filter(Boolean).join(', ')).join('\n')}` : '',
    weightRows.length ? `Fitness extension recent weigh-ins:\n${formatRows(weightRows as unknown as Array<Record<string, unknown>>)}` : '',
    workoutRows.length ? `Fitness extension recent workouts:\n${workoutRows.map((row) => [
      row.workout_date ? `date=${row.workout_date}` : '',
      row.workout_type ? `type=${row.workout_type}` : '',
      row.status ? `status=${row.status}` : '',
      row.rpe ? `rpe=${row.rpe}` : '',
      row.notes ? `notes=${row.notes}` : '',
      stringifyUnknown(row.metrics),
      row.source_ref ? `source=${row.source_ref}` : '',
    ].filter(Boolean).join(', ')).join('\n')}` : '',
  ].filter(Boolean);

  return {
    domain: 'fitness',
    content: sections.join('\n\n'),
  };
}

function buildLenaFileContext(text: string, agentsRoot: string): DomainContext | null {
  const lenaRoot = path.join(agentsRoot, 'lena');
  const memoryPath = path.join(lenaRoot, 'memory', 'agents', 'lena.md');
  const nextWorkout = readFileIfExists(path.join(lenaRoot, 'next-workout.json'), 1200);
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
    nextWorkout ? `Lena current rotation state:\n${nextWorkout}` : '',
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

async function buildDomainContexts(agentKey: string, text: string, agentsRoot: string, now: Date): Promise<DomainContext[]> {
  const contexts: DomainContext[] = [];
  if (shouldLoadRemyContext(agentKey, text)) {
    const context = await buildRemyExtensionContext(now) ?? buildRemyFileContext(text, agentsRoot, now);
    if (context) contexts.push(context);
  }
  if (shouldLoadLenaContext(agentKey, text)) {
    const context = await buildLenaExtensionContext() ?? buildLenaFileContext(text, agentsRoot);
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
  const chatId = input.source === 'discord' ? parseDiscordChatId(input.text) : '';
  const scheduledDiscordOutbox = formatScheduledDiscordOutbox(
    readScheduledDiscordOutbox(input.agentKey, chatId, now),
  );
  const [memoryText, domainContexts] = await Promise.all([
    searchAnswerMemory(input),
    buildDomainContexts(input.agentKey, input.text, agentsRoot, now),
  ]);
  return formatAnswerContext({
    agentKey: input.agentKey,
    source: input.source,
    memoryText,
    domainContexts: [
      ...(scheduledDiscordOutbox ? [{
        domain: 'scheduled_discord_outbox',
        content: scheduledDiscordOutbox,
      }] : []),
      ...domainContexts,
    ],
  });
}
