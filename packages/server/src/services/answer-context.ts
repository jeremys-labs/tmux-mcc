import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import {
  callOpenBrainTool,
  type OpenBrainRuntimeConfig,
} from './open-brain-runtime.js';
import { buildSkillSnapshotForPrompt } from './skill-snapshot.js';

const DEFAULT_AGENTS_ROOT = '/Volumes/Repo-Drive/agents';
const DEFAULT_OPEN_BRAIN_ENV_PATH = '/Volumes/Repo-Drive/src/open-brain/credentials/ob1.env';
const DEFAULT_SCHEDULED_DISCORD_OUTBOX_PATH = '/Volumes/Repo-Drive/agents/SHARED/scheduled-discord-outbox.jsonl';
const DEFAULT_OPEN_BRAIN_RECALL_TRACE_PATH = '/Volumes/Repo-Drive/agents/SHARED/open-brain-recall-traces.jsonl';
const MEMORY_UNAVAILABLE_MARKER = 'Memory retrieval is currently unavailable. Proceed without recalled memory and do not interpret this as an empty memory result.';
const DEFAULT_JEREMY_TIMEZONE_PATH = '/Volumes/Repo-Drive/agents/SHARED/jeremy-timezone.json';
const DEFAULT_JEREMY_TIMEZONE = 'America/New_York';
const DEFAULT_JEREMY_TIMEZONE_LABEL = 'Home (Charlotte)';

export type InboundTurnSource = 'discord' | 'agent_mail' | 'bluebubbles' | 'claude_prompt';

export interface BuildAnswerContextInput {
  agentKey: string;
  source: InboundTurnSource;
  text: string;
  chatId?: string;
  messageId?: string;
  referencedMessageId?: string;
  subject?: string;
  project?: string | null;
  freshSessionFirstTurn?: boolean;
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
  sent_message_id?: string;
  sent_text?: string;
  reply_to?: string;
  source?: string;
  awaiting_reply?: boolean;
}

interface OpenBrainRestConfig {
  projectUrl: string;
  serviceRoleKey: string;
}

interface JeremyTimezoneFile {
  timezone?: unknown;
  label?: unknown;
  reason?: unknown;
  valid_from?: unknown;
  valid_until?: unknown;
  source_ref?: unknown;
}

interface JeremyTimezoneContext {
  timezone: string;
  label: string;
  reason: string;
  sourceRef: string | null;
  status: 'active' | 'fallback';
}

export interface OpenBrainRecallTraceResult {
  rank: number;
  similarity: number | null;
  source_ref: string | null;
  scope: string | null;
  project: string | null;
  authority: string | null;
}

interface OpenBrainRecallTrace {
  timestamp: string;
  agent: string;
  source: InboundTurnSource;
  lookup: 'semantic' | 'recent';
  project?: string | null;
  scope?: string | null;
  threshold?: number | null;
  limit?: number | null;
  query: string;
  result_count: number;
  empty: boolean;
  error?: string;
  results: OpenBrainRecallTraceResult[];
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function compactText(value: string, maxLength = 2400): string {
  const text = value.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trim()}...`;
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function timezoneDateKey(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string => (
    parts.find((part) => part.type === type)?.value ?? ''
  );
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function timezoneAbbreviation(timezone: string): string {
  if (timezone === 'America/New_York') return 'ET';
  if (timezone === 'America/Chicago') return 'CT';
  if (timezone === 'Europe/London') return 'BST';
  return timezone;
}

function fallbackJeremyTimezone(): JeremyTimezoneContext {
  return {
    timezone: DEFAULT_JEREMY_TIMEZONE,
    label: DEFAULT_JEREMY_TIMEZONE_LABEL,
    reason: 'default',
    sourceRef: null,
    status: 'fallback',
  };
}

export function resolveJeremyTimezone(
  now = new Date(),
  filePath = process.env.JEREMY_TIMEZONE_PATH ?? DEFAULT_JEREMY_TIMEZONE_PATH,
): JeremyTimezoneContext {
  const parsed = safeJsonFile(filePath) as JeremyTimezoneFile | null;
  if (!parsed || typeof parsed !== 'object') return fallbackJeremyTimezone();

  const timezone = typeof parsed.timezone === 'string' ? parsed.timezone : '';
  if (!timezone || !isValidTimezone(timezone)) return fallbackJeremyTimezone();

  const today = timezoneDateKey(now, timezone);
  const validFrom = typeof parsed.valid_from === 'string' ? parsed.valid_from : null;
  const validUntil = typeof parsed.valid_until === 'string' ? parsed.valid_until : null;
  if (validFrom && today < validFrom) return fallbackJeremyTimezone();
  if (validUntil && today > validUntil) return fallbackJeremyTimezone();

  return {
    timezone,
    label: typeof parsed.label === 'string' && parsed.label.trim() ? parsed.label.trim() : timezone,
    reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : 'configured',
    sourceRef: typeof parsed.source_ref === 'string' && parsed.source_ref.trim() ? parsed.source_ref.trim() : null,
    status: 'active',
  };
}

export function formatJeremyDateTime(now = new Date(), timezoneContext = resolveJeremyTimezone(now)): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezoneContext.timezone,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string => (
    parts.find((part) => part.type === type)?.value ?? ''
  );
  return [
    value('weekday'),
    `${value('year')}-${value('month')}-${value('day')}`,
    `${value('hour')}:${value('minute')} ${value('dayPeriod')}`,
    timezoneAbbreviation(timezoneContext.timezone),
  ].join(' ');
}

function formatJeremyTimezoneSource(context: JeremyTimezoneContext): string {
  const source = context.sourceRef ? ` (${context.sourceRef})` : '';
  const prefix = context.status === 'fallback' ? 'Timezone source: fallback' : 'Timezone source';
  return `${prefix}: ${context.label} — ${context.reason}${source}.`;
}

function resolveRecallTracePath(): string | null {
  if (process.env.OPEN_BRAIN_RECALL_TRACE_DISABLED === '1') return null;
  return process.env.OPEN_BRAIN_RECALL_TRACE_PATH ?? DEFAULT_OPEN_BRAIN_RECALL_TRACE_PATH;
}

export function parseSearchAgentMemoryTrace(text: string): OpenBrainRecallTraceResult[] {
  const blocks = text.split(/^--- Result /m).slice(1);
  const parsed = blocks.map((block): OpenBrainRecallTraceResult | null => {
    const header = block.match(/^(\d+) \(([\d.]+)% match\)/);
    if (!header) return null;
    const line = (label: string) => block.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null;
    return {
      rank: Number(header[1]),
      similarity: Number(header[2]) / 100,
      source_ref: line('Source'),
      scope: line('Scope'),
      project: line('Project'),
      authority: line('Authority'),
    };
  }).filter((item): item is OpenBrainRecallTraceResult => Boolean(item));
  const topLevel: OpenBrainRecallTraceResult[] = [];
  for (const item of parsed) {
    const previousRank = topLevel[topLevel.length - 1]?.rank ?? 0;
    if (item.rank > previousRank) topLevel.push(item);
  }
  return topLevel;
}

function writeRecallTrace(trace: OpenBrainRecallTrace): void {
  const tracePath = resolveRecallTracePath();
  if (!tracePath) return;
  try {
    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    fs.appendFileSync(tracePath, `${JSON.stringify(trace)}\n`);
  } catch (error) {
    process.stderr.write(`[answer-context] failed to write OB1 recall trace: ${String(error)}\n`);
  }
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
  referencedMessageId?: string,
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
  const records = text
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
    });

  const referenced = referencedMessageId
    ? records.filter((record) => record.sent_message_id === referencedMessageId)
    : [];
  const recentAwaiting = records
    .filter((record) => record.sent_message_id !== referencedMessageId)
    .filter((record) => record.awaiting_reply)
    .filter((record) => {
      if (!record.timestamp) return false;
      const ts = new Date(record.timestamp).getTime();
      return Number.isFinite(ts) && now.getTime() - ts <= 3 * 60 * 60 * 1000;
    });
  const recentOther = records
    .filter((record) => record.sent_message_id !== referencedMessageId)
    .filter((record) => !record.awaiting_reply)
    .filter((record) => record.sent_text)
    .filter((record) => {
      if (!record.timestamp) return false;
      const ts = new Date(record.timestamp).getTime();
      return Number.isFinite(ts) && now.getTime() - ts <= 60 * 60 * 1000;
    });

  const newestFirst = (items: ScheduledDiscordOutboxRecord[]) => items.slice(-5).reverse();
  return [
    ...newestFirst(referenced),
    ...newestFirst(recentAwaiting),
    ...newestFirst(recentOther),
  ].slice(0, 5);
}

function formatScheduledDiscordOutbox(records: ScheduledDiscordOutboxRecord[]): string {
  if (records.length === 0) return '';
  return records.map((record) => [
    `time=${record.timestamp ?? 'unknown'}`,
    `source=${record.source ?? 'scheduled_discord_outbox'}`,
    `job=${record.label ?? record.job_id ?? 'unknown'}`,
    `job_id=${record.job_id ?? 'unknown'}`,
    `awaiting_reply=${record.awaiting_reply ? 'true' : 'false'}`,
    record.sent_message_id ? `sent_message_id=${record.sent_message_id}` : null,
    record.reply_to ? `reply_to=${record.reply_to}` : null,
    record.sent_text ? `sent_text=${compactText(record.sent_text, 1200)}` : null,
    record.prompt_excerpt ? `scheduled_prompt=${compactText(record.prompt_excerpt, 900)}` : null,
  ].filter(Boolean).join('\n')).join('\n\n');
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

function buildSkillsContext(agentKey: string, agentsRoot: string, promptText?: string): DomainContext | null {
  if (process.env.SKILL_SNAPSHOT_CONTEXT_DISABLED === '1') return null;
  const snapshot = buildSkillSnapshotForPrompt({ agentKey, agentsRoot, promptText });
  if (!snapshot.compactPrompt.trim()) return null;
  return {
    domain: 'skills',
    content: [
      `skill_snapshot_version=${snapshot.version}`,
      `skill_count=${snapshot.skills.length}`,
      snapshot.compactPrompt,
    ].join('\n'),
  };
}

function logContextBytes(agentKey: string, source: string, bytes: Record<string, number>): void {
  if (process.env.ANSWER_CONTEXT_BYTE_LOG_DISABLED === '1') return;
  const total = Object.values(bytes).reduce((a, b) => a + b, 0);
  const parts = Object.entries(bytes).map(([k, v]) => `${k}=${v}`).join(' ');
  process.stderr.write(`[answer-context] bytes agent=${agentKey} source=${source} ${parts} total=${total}\n`);
}

function buildMemoryQuery(input: BuildAnswerContextInput): string {
  return [
    input.subject ? `Subject: ${input.subject}` : '',
    input.project ? `Project: ${input.project}` : '',
    input.text,
    'current source-of-truth preferences recent relevant state before answering',
  ].filter(Boolean).join('\n');
}

interface OB1ResultBlock {
  rank: number;
  similarity: number;
  metadata: Record<string, string>;
  body: string;
}

function parseOB1ResultBlocks(text: string): OB1ResultBlock[] {
  const blocks = text.split(/^--- Result /m).slice(1);
  const topLevel: OB1ResultBlock[] = [];
  for (const block of blocks) {
    const header = block.match(/^(\d+) \(([\d.]+)% match\)/);
    if (!header) continue;
    const rank = Number(header[1]);
    if (topLevel.length > 0 && rank <= topLevel[topLevel.length - 1].rank) continue;
    const similarity = Number(header[2]) / 100;
    const lines = block.split('\n');
    const metaLines: string[] = [];
    const bodyLines: string[] = [];
    let pastHeader = false;
    let inBody = false;
    for (const line of lines) {
      if (!pastHeader) { pastHeader = true; continue; }
      if (!inBody) {
        if (line.trim() === '') { inBody = true; } else { metaLines.push(line); }
      } else {
        bodyLines.push(line);
      }
    }
    const metadata: Record<string, string> = {};
    for (const line of metaLines) {
      const colon = line.indexOf(':');
      if (colon > 0) {
        metadata[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
    }
    topLevel.push({ rank, similarity, metadata, body: bodyLines.join('\n').trimEnd() });
  }
  return topLevel;
}

function resultPassesAdmissionGate(
  block: OB1ResultBlock,
  promptText: string,
  baseThreshold: number,
  inputProject?: string | null,
): boolean {
  if (block.metadata.authority === 'source_of_truth') return true;
  const scope = block.metadata.scope ?? '';
  if (scope === 'shared_team' || scope === '') return block.similarity >= baseThreshold;
  const project = block.metadata.project ?? '';
  const owner = block.metadata.owner ?? '';
  const topics = (block.metadata.topics ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  if (inputProject && project && inputProject.toLowerCase() === project.toLowerCase()) {
    return block.similarity >= baseThreshold;
  }
  const promptLower = promptText.toLowerCase();
  const contextTerms = [project, owner, ...topics].filter((t) => t.length > 3);
  if (contextTerms.some((term) => promptLower.includes(term.toLowerCase()))) {
    return block.similarity >= baseThreshold;
  }
  const highThreshold = numberFromEnv('ANSWER_CONTEXT_MEMORY_HIGH_THRESHOLD', 0.72);
  return block.similarity >= highThreshold;
}

export function compactOB1Results(
  text: string,
  promptText: string,
  baseThreshold: number,
  inputProject?: string | null,
): string {
  if (!text.trim()) return text;
  const blocks = parseOB1ResultBlocks(text);
  if (blocks.length === 0) return text;
  const admitted = blocks.filter((block) =>
    resultPassesAdmissionGate(block, promptText, baseThreshold, inputProject)
  );
  if (admitted.length === 0) return '';
  const firstLine = text.split('\n')[0];
  const newFirstLine = firstLine.replace(/^Found \d+/, `Found ${admitted.length}`);
  const formattedBlocks = admitted.map((block, idx) => {
    const isHighValue = block.metadata.authority === 'source_of_truth' || block.similarity >= 0.85;
    const bodyBudget = isHighValue ? 1200 : 300;
    const metaSection = Object.entries(block.metadata)
      .map(([k, v]) => `${k.charAt(0).toUpperCase() + k.slice(1)}: ${v}`)
      .join('\n');
    const body = compactText(block.body, bodyBudget);
    return [
      `--- Result ${idx + 1} (${(block.similarity * 100).toFixed(1)}% match) ---`,
      metaSection,
      '',
      body,
    ].join('\n');
  });
  return `${newFirstLine}\n\n${formattedBlocks.join('\n\n')}`;
}

async function safeSearchAgentMemory(
  config: OpenBrainRuntimeConfig,
  args: Record<string, unknown>,
  traceInput?: {
    agentKey: string;
    source: InboundTurnSource;
    lookup: 'semantic' | 'recent';
  },
): Promise<string> {
  const startedAt = new Date();
  const query = typeof args.query === 'string' ? args.query : '';
  try {
    const result = await callOpenBrainTool(config, 'search_agent_memory', args, {
      maxAttempts: 2,
      retryDelayMs: 100,
    });
    if (traceInput) {
      const results = parseSearchAgentMemoryTrace(result.text);
      writeRecallTrace({
        timestamp: startedAt.toISOString(),
        agent: traceInput.agentKey,
        source: traceInput.source,
        lookup: traceInput.lookup,
        project: typeof args.project === 'string' ? args.project : null,
        scope: typeof args.scope === 'string' ? args.scope : null,
        threshold: typeof args.threshold === 'number' ? args.threshold : null,
        limit: typeof args.limit === 'number' ? args.limit : null,
        query: compactText(query, 2000),
        result_count: results.length,
        empty: results.length === 0,
        results,
      });
    }
    return result.text;
  } catch (error) {
    if (traceInput) {
      writeRecallTrace({
        timestamp: startedAt.toISOString(),
        agent: traceInput.agentKey,
        source: traceInput.source,
        lookup: traceInput.lookup,
        project: typeof args.project === 'string' ? args.project : null,
        scope: typeof args.scope === 'string' ? args.scope : null,
        threshold: typeof args.threshold === 'number' ? args.threshold : null,
        limit: typeof args.limit === 'number' ? args.limit : null,
        query: compactText(query, 2000),
        result_count: 0,
        empty: true,
        error: String(error),
        results: [],
      });
    }
    process.stderr.write(
      `[answer-context] search_agent_memory failed for ${traceInput?.agentKey ?? config.agentId}: ${String(error)}\n`,
    );
    return MEMORY_UNAVAILABLE_MARKER;
  }
}

async function searchAnswerMemory(input: BuildAnswerContextInput): Promise<string> {
  if (!input.openBrainConfig) return '';
  const semanticLimit = numberFromEnv('ANSWER_CONTEXT_MEMORY_LIMIT', 1);
  const semanticThreshold = numberFromEnv('ANSWER_CONTEXT_MEMORY_THRESHOLD', 0.45);
  const sectionCap = numberFromEnv('ANSWER_CONTEXT_MEMORY_CHAR_CAP', 2400);
  const recentFallbackLimit = numberFromEnv('ANSWER_CONTEXT_RECENT_MEMORY_LIMIT', semanticLimit);
  const [rawSemanticResult, recentResult] = await Promise.all([
    safeSearchAgentMemory(input.openBrainConfig, {
      agent_id: input.openBrainConfig.agentId,
      query: buildMemoryQuery(input),
      project: input.project ?? undefined,
      limit: semanticLimit,
      threshold: semanticThreshold,
    }, { agentKey: input.agentKey, source: input.source, lookup: 'semantic' }),
    input.freshSessionFirstTurn
      ? safeSearchAgentMemory(input.openBrainConfig, {
        agent_id: input.openBrainConfig.agentId,
        query: `recent ${input.openBrainConfig.agentId} session activity work troubleshooting restart current task`,
        project: input.project ?? undefined,
        limit: recentFallbackLimit,
        threshold: semanticThreshold,
      }, { agentKey: input.agentKey, source: input.source, lookup: 'recent' })
      : Promise.resolve(''),
  ]);
  const semanticResult = compactOB1Results(rawSemanticResult, input.text, semanticThreshold, input.project);
  const compactRecentResult = compactOB1Results(recentResult, input.text, semanticThreshold, input.project);
  const sections = [...new Set([
    semanticResult,
    compactRecentResult.trim()
      ? [
        'Recent activity fallback for fresh session first turn:',
        compactRecentResult,
      ].join('\n')
      : '',
  ].filter((section) => section.trim()))];
  return compactText(sections.join('\n\n'), sectionCap);
}

function hasAssistantRole(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasAssistantRole);
  const record = value as Record<string, unknown>;
  if (record.role === 'assistant') return true;
  if (record.type === 'assistant') return true;
  if (record.message && hasAssistantRole(record.message)) return true;
  return false;
}

function transcriptHasAssistantTurn(filePath: string): boolean {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .some((line) => {
        try {
          return hasAssistantRole(JSON.parse(line) as unknown);
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

export function isFreshSessionFirstTurnPayload(payload: Record<string, unknown>): boolean {
  const transcriptPath = payload.transcript_path ?? payload.transcriptPath;
  if (typeof transcriptPath === 'string' && transcriptPath) {
    return !transcriptHasAssistantTurn(transcriptPath);
  }

  const candidateFields = [
    payload.messages,
    payload.conversation,
    payload.conversation_context,
    payload.conversationContext,
    payload.transcript,
    payload.turns,
  ];
  if (candidateFields.some((field) => Array.isArray(field))) {
    return !candidateFields.some(hasAssistantRole);
  }

  if (payload.parentUuid === null || payload.parent_uuid === null) return true;
  if (payload.parentUuid || payload.parent_uuid) return false;

  return false;
}

export function formatAnswerContext(input: {
  agentKey: string;
  source: InboundTurnSource;
  now?: Date;
  memoryText?: string;
  domainContexts?: DomainContext[];
}): string {
  const sections: string[] = [];
  const timezoneContext = resolveJeremyTimezone(input.now);
  sections.push([
    '<domain_state domain="current_datetime">',
    `The current date/time in Jeremy's timezone is ${formatJeremyDateTime(input.now, timezoneContext)}.`,
    formatJeremyTimezoneSource(timezoneContext),
    '</domain_state>',
  ].join('\n'));

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
  const chatId = input.source === 'discord' ? (input.chatId ?? parseDiscordChatId(input.text)) : '';
  const scheduledDiscordOutbox = formatScheduledDiscordOutbox(
    readScheduledDiscordOutbox(input.agentKey, chatId, now, input.referencedMessageId),
  );
  const [memoryText, domainContexts] = await Promise.all([
    searchAnswerMemory(input),
    buildDomainContexts(input.agentKey, input.text, agentsRoot, now),
  ]);
  const skillsContext = buildSkillsContext(input.agentKey, agentsRoot, input.text);
  const extraDomains: DomainContext[] = [
    ...(scheduledDiscordOutbox ? [{ domain: 'scheduled_discord_outbox', content: scheduledDiscordOutbox }] : []),
    ...(skillsContext ? [skillsContext] : []),
    ...domainContexts,
  ];
  logContextBytes(input.agentKey, input.source, {
    memory: Buffer.byteLength(memoryText ?? ''),
    skills: Buffer.byteLength(skillsContext?.content ?? ''),
    domain: Buffer.byteLength(extraDomains.filter((d) => d.domain !== 'scheduled_discord_outbox' && d.domain !== 'skills').map((d) => d.content).join('')),
    outbox: Buffer.byteLength(scheduledDiscordOutbox),
  });
  return formatAnswerContext({
    agentKey: input.agentKey,
    source: input.source,
    now,
    memoryText,
    domainContexts: extraDomains,
  });
}
