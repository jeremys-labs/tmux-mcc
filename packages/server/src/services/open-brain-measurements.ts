import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveContentRoot } from '../config.js';
import type { GroomingScheduledResult } from './open-brain-grooming-schedule.js';

export interface OpenBrainMeasurementEvent {
  schema_version: 1;
  id: string;
  ts: string;
  system: 'ob1';
  area: 'grooming';
  criterion: string;
  owner_agent: string;
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  passed: boolean;
  status: 'pass' | 'warn' | 'fail';
  evidence_ref: string;
  metadata?: Record<string, unknown>;
}

export interface BuildGroomingMeasurementOptions {
  generatedAtIso: string;
  sinceIso: string;
  ownerAgent: string;
  pendingReviewCount: number;
  dryRun?: boolean;
}

export function resolveOpenBrainMeasurementsPath(contentRoot = resolveContentRoot()): string {
  return path.join(contentRoot, 'open-brain', 'measurements.jsonl');
}

function measurementId(ts: string, criterion: string, evidenceRef: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${ts}\n${criterion}\n${evidenceRef}`)
    .digest('hex')
    .slice(0, 16);
  return `ob1_measurement_${digest}`;
}

function buildMeasurement(args: Omit<OpenBrainMeasurementEvent, 'schema_version' | 'id' | 'system' | 'area'>): OpenBrainMeasurementEvent {
  return {
    schema_version: 1,
    id: measurementId(args.ts, args.criterion, args.evidence_ref),
    system: 'ob1',
    area: 'grooming',
    ...args,
  };
}

export function buildOpenBrainGroomingMeasurements(
  result: GroomingScheduledResult,
  options: BuildGroomingMeasurementOptions,
): OpenBrainMeasurementEvent[] {
  const evidenceRef = `open-brain:grooming-digest:${options.generatedAtIso}`;
  const autoPromotedCount =
    result.summary.itemAutoPromotedPrivate +
    result.summary.itemAutoPromotedProject +
    result.summary.clusterAutoPromotedPrivate +
    result.summary.clusterAutoPromotedProject;
  const ignoredCount = result.summary.itemAutoIgnored + result.summary.clusterIgnored;
  const needsReviewCount = result.summary.itemNeedsReview + result.summary.clusterNeedsReview;
  const classifierHealthy = result.classifierFailureCount === 0;
  const applyHealthy = result.applyFailureCount === 0;

  return [
    buildMeasurement({
      ts: options.generatedAtIso,
      criterion: 'grooming_run_completed',
      owner_agent: options.ownerAgent,
      expected: { command_completed: true, dry_run: false },
      actual: {
        command_completed: true,
        dry_run: Boolean(options.dryRun),
        raw_capture_count: result.rawCaptureCount,
        since_iso: options.sinceIso,
      },
      passed: !options.dryRun,
      status: options.dryRun ? 'warn' : 'pass',
      evidence_ref: evidenceRef,
    }),
    buildMeasurement({
      ts: options.generatedAtIso,
      criterion: 'grooming_actions_measured',
      owner_agent: options.ownerAgent,
      expected: { action_counts_recorded: true },
      actual: {
        auto_promoted_count: autoPromotedCount,
        ignored_count: ignoredCount,
        needs_review_count: needsReviewCount,
        cluster_skipped_count: result.summary.clusterSkipped,
        item_auto_ignored: result.summary.itemAutoIgnored,
        item_auto_promoted_private: result.summary.itemAutoPromotedPrivate,
        item_auto_promoted_project: result.summary.itemAutoPromotedProject,
        item_needs_review: result.summary.itemNeedsReview,
        cluster_ignored: result.summary.clusterIgnored,
        cluster_auto_promoted_private: result.summary.clusterAutoPromotedPrivate,
        cluster_auto_promoted_project: result.summary.clusterAutoPromotedProject,
        cluster_needs_review: result.summary.clusterNeedsReview,
      },
      passed: true,
      status: 'pass',
      evidence_ref: evidenceRef,
    }),
    buildMeasurement({
      ts: options.generatedAtIso,
      criterion: 'grooming_review_queue_measured',
      owner_agent: options.ownerAgent,
      expected: { pending_review_count_recorded: true },
      actual: {
        new_review_candidates: result.reviewCandidates.length,
        pending_review_count: options.pendingReviewCount,
      },
      passed: true,
      status: 'pass',
      evidence_ref: evidenceRef,
    }),
    buildMeasurement({
      ts: options.generatedAtIso,
      criterion: 'grooming_classifier_healthy',
      owner_agent: options.ownerAgent,
      expected: { classifier_failure_count: 0, classifier_failure_cycles_lt: 3 },
      actual: {
        classifier_failure_count: result.classifierFailureCount,
        classifier_failure_cycles: result.classifierFailureCycles,
      },
      passed: classifierHealthy,
      status: classifierHealthy ? 'pass' : result.classifierFailureCycles >= 3 ? 'fail' : 'warn',
      evidence_ref: evidenceRef,
    }),
    buildMeasurement({
      ts: options.generatedAtIso,
      criterion: 'grooming_apply_healthy',
      owner_agent: options.ownerAgent,
      expected: { apply_failure_count: 0 },
      actual: { apply_failure_count: result.applyFailureCount },
      passed: applyHealthy,
      status: applyHealthy ? 'pass' : 'fail',
      evidence_ref: evidenceRef,
    }),
  ];
}

export function appendOpenBrainMeasurements(
  events: OpenBrainMeasurementEvent[],
  options: { contentRoot?: string } = {},
): string {
  const ledgerPath = resolveOpenBrainMeasurementsPath(options.contentRoot);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const lines = events.map((event) => `${JSON.stringify(event)}\n`).join('');
  fs.appendFileSync(ledgerPath, lines, 'utf8');
  return ledgerPath;
}
