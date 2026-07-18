import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildSkillsContext,
  formatAnswerContext,
  type InboundTurnSource,
} from './answer-context.js';

// Fast Discord chat lane (env-gated, default OFF).
//
// STRUCTURAL INVARIANT: default/ambiguous classifies DEEP. fast_chat requires a
// positive match on the fast allowlist AND zero deep/coordination/personal/
// current triggers. A prompt that matches nothing is deep_work — never fast.

export type IntentLane =
  | 'fast_chat'
  | 'current_lookup'
  | 'personal_context'
  | 'deep_work'
  | 'coordination';

export interface IntentLaneInput {
  text: string;
  hasAttachments?: boolean;
  referencedMessageId?: string;
}

export interface IntentLaneDecision {
  lane: IntentLane;
  reasons: string[];
}

const LONG_MESSAGE_CHARS = 600;

const AGENT_NAMES =
  /\b(isla|eli|harper|sage|nova|zara|remy|lena|val|hank|enzo|jordan|hercule|cecelia|marcus|clawdbot)\b/i;

const PERSON_NAMES =
  /\b(alison|lizzy|elisabeth|alex|alexander|cindy|tom|mike|wife|kids?|son|daughter|family|mom|dad|parents)\b/i;

const PRIOR_CONTEXT =
  /\b(remember|last time|we (discussed|talked|agreed)|did you|have you|status of|what happened|where did we land|follow[- ]?up|that thing|you (said|mentioned)|earlier)\b/i;

// Action words that always mean scheduling/automation work — checked before names.
const SCHEDULE_ACTIONS = /\b(remind(er)? me|schedule|cron|newsletter|every (day|week|morning|night)|daily|weekly|job)\b/i;

// Bare time references — force non-fast, but a person/agent mention outranks
// them (a calendar question about a person is personal/coordination, not work).
const TIME_WORDS = /\b(tomorrow|tonight|next week|at \d{1,2}(:\d{2})?\s?(am|pm)?)\b/i;

const HIGH_RISK =
  /\b(password|credential|token|api ?key|1password|secret|bank|invest(ing|ment)?|loan|mortgage|tax(es)?|payment|budget|salary|doctor|medical|medicine|health|symptom|prescri\w*|insurance claim|legal|lawyer|attorney|contract|lawsuit)\b/i;

const WORK_WORDS =
  /\b(build|implement|deploy|commit|push|branch|repo|repository|pull request|\bpr\b|merge|bug|fix|refactor|test suite|pipeline|migration|codebase|code review)\b/i;

const CURRENT_LOOKUP =
  /\b(latest|current(ly)?|today|right now|news|score|weather|stock|price|traffic|route|directions|open (now|late)|hours)\b/i;

const SKILL_MENTION =
  /\b(skill|tool|image|picture|photo|draw|render|browser|screenshot|credential|password|1password|plugin|canary|generate)\b/i;

const FAST_PATTERNS: Array<{ reason: string; pattern: RegExp }> = [
  {
    reason: 'ping_or_banter',
    pattern:
      /^(yo|hey|hi|hello|sup|good (morning|afternoon|evening|night)|you (up|there|around)\??|how'?s it going\??|how are you\??|thanks?( you)?!?|thank you|ty|lol|l?ma?o|ha(ha)*|nice|cool|ok(ay)?|great|sweet|wow|👍|🙏|😂|❤️)[.!?\s]*$/i,
  },
  { reason: 'emoji_only', pattern: /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u },
  {
    reason: 'quick_opinion',
    pattern: /^(what do you think (of|about)|thoughts on|is (this|that|it) a (dumb|good|bad|crazy) idea)\b/i,
  },
  {
    reason: 'general_knowledge',
    pattern: /^(what('| i)?s the difference between|what (is|are)|define|explain|how (does|do)\b)/i,
  },
  { reason: 'general_why', pattern: /^why\b/i },
  {
    reason: 'meta_followup',
    pattern: /^(shorter|longer|simpler|explain that|why\??|how so\??|say more|expand|tl;?dr|really\??)[.!?\s]*$/i,
  },
];

export function classifyIntentLane(input: IntentLaneInput): IntentLaneDecision {
  const text = input.text.trim();
  const reasons: string[] = [];

  // Hard structural exits first — these can never be fast.
  if (input.hasAttachments) return { lane: 'deep_work', reasons: ['attachments'] };
  if (input.referencedMessageId) {
    // Replies may target scheduled/agent-initiated messages; without cheap
    // provenance here, all reply-references route to personal_context.
    return { lane: 'personal_context', reasons: ['reply_reference'] };
  }
  if (text.length > LONG_MESSAGE_CHARS) return { lane: 'deep_work', reasons: ['long_message'] };

  if (HIGH_RISK.test(text)) reasons.push('high_risk');
  if (SCHEDULE_ACTIONS.test(text)) reasons.push('schedule_actions');
  if (reasons.length > 0) return { lane: 'deep_work', reasons };

  // Names outrank generic work/time words: "did Eli push the fix?" is
  // coordination, "is Tom around next week?" is personal — both non-fast.
  if (AGENT_NAMES.test(text)) return { lane: 'coordination', reasons: ['agent_name'] };
  if (PERSON_NAMES.test(text)) return { lane: 'personal_context', reasons: ['person_name'] };
  if (PRIOR_CONTEXT.test(text)) return { lane: 'personal_context', reasons: ['prior_context_reference'] };
  if (WORK_WORDS.test(text)) return { lane: 'deep_work', reasons: ['work_words'] };
  if (TIME_WORDS.test(text)) return { lane: 'deep_work', reasons: ['time_words'] };
  if (CURRENT_LOOKUP.test(text)) return { lane: 'current_lookup', reasons: ['current_lookup_words'] };

  // Positive fast allowlist — only reachable with zero deep triggers above.
  for (const candidate of FAST_PATTERNS) {
    if (candidate.pattern.test(text) && text.length <= 200) {
      return { lane: 'fast_chat', reasons: [candidate.reason] };
    }
  }

  // Structural invariant: ambiguous -> deep, never fast.
  return { lane: 'deep_work', reasons: ['default_ambiguous'] };
}

export function fastContextEnabled(agentKey: string, env: Record<string, string | undefined>): boolean {
  if (env.DISCORD_FAST_CONTEXT_ENABLED !== '1') return false;
  const allowlist = (env.DISCORD_FAST_CONTEXT_AGENTS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length === 0) return true;
  return allowlist.includes(agentKey.toLowerCase());
}

export interface BuildFastAnswerContextInput {
  agentKey: string;
  source: InboundTurnSource;
  text: string;
  agentsRoot?: string;
  now?: Date;
}

const ESCALATION_INSTRUCTION = [
  'This is a fast-lane context: minimal by design (no recalled memory, no schedules).',
  'If answering this message actually requires personal memory, current/live information,',
  'schedules/reminders, code or work execution, or coordination with other agents, switch to the',
  'deeper path — use your full tools and memory recall as you normally would — rather than',
  'answering from this thin context.',
].join(' ');

function compactAgentProfile(agentKey: string, agentsRoot: string): string {
  const lines = [`Agent: ${agentKey}.`];
  try {
    const identity = fs.readFileSync(path.join(agentsRoot, agentKey, 'IDENTITY.md'), 'utf8');
    lines.push(identity.split('\n').slice(0, 8).join('\n').slice(0, 500));
  } catch {
    // Identity file is optional; the agent key alone is always safe.
  }
  return lines.join('\n');
}

export function buildFastAnswerContext(input: BuildFastAnswerContextInput): string {
  const agentsRoot = input.agentsRoot ?? process.env.AGENTS_ROOT ?? '/Volumes/Repo-Drive/agents';
  const domainContexts = [
    { domain: 'runtime_profile', content: compactAgentProfile(input.agentKey, agentsRoot) },
    { domain: 'fast_lane', content: ESCALATION_INSTRUCTION },
  ];
  if (SKILL_MENTION.test(input.text)) {
    const skills = buildSkillsContext(input.agentKey, agentsRoot, input.text);
    if (skills) domainContexts.push(skills);
  }
  return formatAnswerContext({
    agentKey: input.agentKey,
    source: input.source,
    ...(input.now !== undefined ? { now: input.now } : {}),
    domainContexts,
  });
}

export interface DiscordTurnLatencyRecord {
  agentKey: string;
  messageId: string;
  chatId: string;
  lane: IntentLane;
  fastPathUsed: boolean;
  answerContextMs: number;
  contextBytes: number;
}

const DEFAULT_LATENCY_DIR = path.join(os.homedir(), '.tmux-mcc', 'bridge', 'latency');

/** Appends one JSONL record per Discord turn. Never includes message content. */
export function recordDiscordTurnLatency(record: DiscordTurnLatencyRecord, dir = DEFAULT_LATENCY_DIR): string {
  const file = path.join(dir, 'discord-turns.jsonl');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  return file;
}
