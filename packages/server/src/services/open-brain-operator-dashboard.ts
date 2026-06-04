import fs from 'node:fs';
import {
  fetchRawCapturesSince,
  readDigestState,
  readLastDecisionDigest,
  type GroomingDigestState,
  type LastDecisionDigestRecord,
  type RawCaptureRow,
} from './open-brain-grooming-digest.js';
import {
  resolveOpenBrainMeasurementsPath,
  type OpenBrainMeasurementEvent,
} from './open-brain-measurements.js';
import { resolveContentRoot } from '../config.js';

export interface OperatorDashboardOptions {
  sinceIso: string;
  nowIso: string;
  liveRawCaptureLimit?: number;
  includeLiveRawCaptures?: boolean;
  measurementsPath?: string;
  digestState?: GroomingDigestState;
  lastDecisionDigest?: LastDecisionDigestRecord | null;
  measurementEvents?: OpenBrainMeasurementEvent[];
  rawCaptures?: RawCaptureRow[];
}

interface AgentStats {
  agent: string;
  rawCaptureCount: number;
  autoPromoted: number;
  ignored: number;
  needsReview: number;
  pendingRawCaptures: number;
  classifierFailures: number;
  applyFailures: number;
  latestEventIso?: string;
}

interface DashboardModel {
  sinceIso: string;
  nowIso: string;
  contentRoot: string;
  measurementsPath: string;
  digestState: GroomingDigestState;
  lastDecisionDigest: LastDecisionDigestRecord | null;
  agents: AgentStats[];
  pendingBySource: Array<{ sourceType: string; count: number }>;
  warnings: string[];
  rawCaptureLimit: number;
}

function ownerAgent(row: RawCaptureRow): string {
  return row.metadata?.owner_agent || row.metadata?.agent_id || 'unknown';
}

function sourceType(row: RawCaptureRow): string {
  return row.metadata?.source_type || 'unknown';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function readMeasurementEvents(filePath = resolveOpenBrainMeasurementsPath()): OpenBrainMeasurementEvent[] {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as OpenBrainMeasurementEvent);
  } catch {
    return [];
  }
}

function emptyAgentStats(agent: string): AgentStats {
  return {
    agent,
    rawCaptureCount: 0,
    autoPromoted: 0,
    ignored: 0,
    needsReview: 0,
    pendingRawCaptures: 0,
    classifierFailures: 0,
    applyFailures: 0,
  };
}

function getAgentStats(stats: Map<string, AgentStats>, agent: string): AgentStats {
  const existing = stats.get(agent);
  if (existing) return existing;
  const created = emptyAgentStats(agent);
  stats.set(agent, created);
  return created;
}

function aggregateMeasurements(events: OpenBrainMeasurementEvent[], sinceIso: string): Map<string, AgentStats> {
  const stats = new Map<string, AgentStats>();
  const sinceMs = new Date(sinceIso).getTime();

  for (const event of events) {
    const eventMs = new Date(event.ts).getTime();
    if (Number.isFinite(sinceMs) && Number.isFinite(eventMs) && eventMs < sinceMs) continue;

    const agent = getAgentStats(stats, event.owner_agent || 'unknown');
    if (!agent.latestEventIso || event.ts > agent.latestEventIso) agent.latestEventIso = event.ts;

    if (event.criterion === 'grooming_run_completed') {
      agent.rawCaptureCount += asNumber(event.actual.raw_capture_count);
    }
    if (event.criterion === 'grooming_actions_measured') {
      agent.autoPromoted += asNumber(event.actual.auto_promoted_count);
      agent.ignored += asNumber(event.actual.ignored_count);
      agent.needsReview += asNumber(event.actual.needs_review_count);
    }
    if (event.criterion === 'grooming_classifier_healthy') {
      agent.classifierFailures += asNumber(event.actual.classifier_failure_count);
    }
    if (event.criterion === 'grooming_apply_healthy') {
      agent.applyFailures += asNumber(event.actual.apply_failure_count);
    }
  }

  return stats;
}

function buildWarnings(model: Omit<DashboardModel, 'warnings'>): string[] {
  const warnings: string[] = [];
  const state = model.digestState;
  const lastRunMs = state.lastRunIso ? new Date(state.lastRunIso).getTime() : NaN;
  const nowMs = new Date(model.nowIso).getTime();
  if (!state.lastRunIso) warnings.push('No grooming lastRunIso recorded.');
  else if (Number.isFinite(lastRunMs) && Number.isFinite(nowMs) && nowMs - lastRunMs > 2 * 60 * 60 * 1000) {
    warnings.push(`Grooming last run is older than 2h: ${state.lastRunIso}.`);
  }
  if ((state.classifierFailureCycles ?? 0) > 0) {
    warnings.push(`Classifier failure cycles: ${state.classifierFailureCycles}.`);
  }
  const pendingReview = Array.isArray(state.pendingReviewCandidates) ? state.pendingReviewCandidates.length : 0;
  if (pendingReview > 0) warnings.push(`Pending review candidates in state: ${pendingReview}.`);
  for (const agent of model.agents) {
    if (agent.pendingRawCaptures > 50) warnings.push(`${agent.agent} has ${agent.pendingRawCaptures} live unresolved raw captures.`);
    if (agent.classifierFailures > 0) warnings.push(`${agent.agent} classifier failures in window: ${agent.classifierFailures}.`);
    if (agent.applyFailures > 0) warnings.push(`${agent.agent} apply failures in window: ${agent.applyFailures}.`);
  }
  return warnings;
}

export function buildOperatorDashboardModel(options: OperatorDashboardOptions): DashboardModel {
  const measurementEvents = options.measurementEvents ?? readMeasurementEvents(options.measurementsPath);
  const digestState = options.digestState ?? readDigestState();
  const lastDecisionDigest = options.lastDecisionDigest ?? readLastDecisionDigest();
  const rawCaptures = options.rawCaptures ?? [];
  const stats = aggregateMeasurements(measurementEvents, options.sinceIso);

  for (const row of rawCaptures) {
    getAgentStats(stats, ownerAgent(row)).pendingRawCaptures += 1;
  }

  const model: Omit<DashboardModel, 'warnings'> = {
    sinceIso: options.sinceIso,
    nowIso: options.nowIso,
    contentRoot: resolveContentRoot(),
    measurementsPath: options.measurementsPath ?? resolveOpenBrainMeasurementsPath(),
    digestState,
    lastDecisionDigest,
    agents: [...stats.values()].sort((a, b) => {
      const totalA = a.pendingRawCaptures + a.rawCaptureCount + a.needsReview;
      const totalB = b.pendingRawCaptures + b.rawCaptureCount + b.needsReview;
      return totalB - totalA || a.agent.localeCompare(b.agent);
    }),
    pendingBySource: countBy(rawCaptures, sourceType).map(({ key, count }) => ({ sourceType: key, count })),
    rawCaptureLimit: options.liveRawCaptureLimit ?? rawCaptures.length,
  };

  return {
    ...model,
    warnings: buildWarnings(model),
  };
}

export function formatOperatorDashboard(model: DashboardModel): string {
  const pendingReview = Array.isArray(model.digestState.pendingReviewCandidates)
    ? model.digestState.pendingReviewCandidates.length
    : 0;
  const lines = [
    `OB1 operator dashboard (${model.sinceIso} -> ${model.nowIso})`,
    `Content root: ${model.contentRoot}`,
    `Measurements: ${model.measurementsPath}`,
    '',
    `Last grooming run: ${model.digestState.lastRunIso ?? 'unknown'}`,
    `Classifier failure cycles: ${model.digestState.classifierFailureCycles ?? 0}`,
    `Pending review candidates: ${pendingReview}`,
    `Last decision digest: ${model.lastDecisionDigest?.generatedAtIso ?? 'none'} (${model.lastDecisionDigest?.count ?? 0} entries)`,
    '',
    'Agent health:',
  ];

  if (!model.agents.length) {
    lines.push('- No measurement or pending raw-capture data in window.');
  } else {
    for (const agent of model.agents) {
      lines.push([
        `- ${agent.agent}:`,
        `raw=${agent.rawCaptureCount}`,
        `promoted=${agent.autoPromoted}`,
        `ignored=${agent.ignored}`,
        `needs_review=${agent.needsReview}`,
        `pending_raw=${agent.pendingRawCaptures}`,
        `classifier_fail=${agent.classifierFailures}`,
        `apply_fail=${agent.applyFailures}`,
        `latest=${agent.latestEventIso ?? 'none'}`,
      ].join(' '));
    }
  }

  lines.push('', 'Pending raw captures by source:');
  if (!model.pendingBySource.length) lines.push('- none');
  else {
    for (const entry of model.pendingBySource) lines.push(`- ${entry.sourceType}: ${entry.count}`);
  }

  lines.push('', 'Warnings:');
  if (!model.warnings.length) lines.push('- none');
  else {
    for (const warning of model.warnings) lines.push(`- ${warning}`);
  }

  return lines.join('\n');
}

export async function buildOperatorDashboard(options: Omit<OperatorDashboardOptions, 'rawCaptures'>): Promise<DashboardModel> {
  const rawCaptureLimit = options.liveRawCaptureLimit ?? 200;
  const rawCaptures = options.includeLiveRawCaptures === false
    ? []
    : await fetchRawCapturesSince(options.sinceIso, rawCaptureLimit);
  return buildOperatorDashboardModel({
    ...options,
    rawCaptures,
    liveRawCaptureLimit: rawCaptureLimit,
  });
}
