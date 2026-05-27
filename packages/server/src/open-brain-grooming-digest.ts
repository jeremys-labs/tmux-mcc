import { readDigestState, resolveDigestChannelId, sendDiscordDigest, writeDigestState } from './services/open-brain-grooming-digest.js';
import { appendOpenBrainMeasurements, buildOpenBrainGroomingMeasurements } from './services/open-brain-measurements.js';
import {
  buildPendingReviewDigest,
  mergeReviewCandidates,
  pruneResolvedReviewCandidates,
  runScheduledGrooming,
  type GroomingScheduledCandidate,
} from './services/open-brain-grooming-schedule.js';

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const now = new Date();
  const generatedAtIso = now.toISOString();
  const sinceIso = readArg('--since');
  const limit = Number(readArg('--limit') ?? '80');
  const maxItems = Number(readArg('--max-items') ?? '12');
  const dryRun = hasFlag('--dry-run');
  const silentWhenClean = hasFlag('--silent-when-clean');
  const suppressReviewDigest = hasFlag('--suppress-review-digest');
  const sendPendingReviewDigest = hasFlag('--send-pending-review-digest');

  if (sendPendingReviewDigest) {
    const state = readDigestState();
    const pending = (state.pendingReviewCandidates ?? []) as GroomingScheduledCandidate[];
    const activePending = await pruneResolvedReviewCandidates(pending);
    if (activePending.length === 0) {
      if (pending.length > 0) {
        writeDigestState({
          ...state,
          pendingReviewCandidates: [],
          lastDecisionDigestIso: generatedAtIso,
        });
      }
      process.stdout.write('No pending OB1 grooming decisions; skipping Discord digest.\n');
      return;
    }

    const digest = buildPendingReviewDigest(activePending, generatedAtIso, maxItems);
    if (dryRun) {
      process.stdout.write(`${digest}\n`);
      return;
    }

    await sendDiscordDigest(digest, resolveDigestChannelId());
    writeDigestState({
      ...state,
      pendingReviewCandidates: [],
      lastDecisionDigestIso: generatedAtIso,
    });
    process.stdout.write(`Sent OB1 decision digest for ${activePending.length} pending candidates.\n`);
    return;
  }

  const result = await runScheduledGrooming({
    actorAgent: 'eli',
    sinceIso,
    generatedAtIso,
    limit,
    maxItems,
    dryRun,
  });

  if (dryRun) {
    process.stdout.write(`${result.digest}\n`);
    return;
  }

  const needsReviewCount =
    result.summary.itemNeedsReview + result.summary.clusterNeedsReview;
  const hasAnyActivity = result.rawCaptureCount > 0;
  const state = readDigestState();
  // Advance the cursor to the highest created_at observed in this batch, not
  // wall-clock `now()`. The fetch is bounded by a per-call row limit; jumping
  // straight to `now()` orphans every row past the limit and the hourly cron
  // never picks them up. Falling back to generatedAtIso is safe when the batch
  // was empty (nothing left to process).
  const lastRunIso = result.maxProcessedCreatedAt ?? generatedAtIso;
  const nextState = {
    ...state,
    lastRunIso,
    classifierFailureCycles: result.classifierFailureCycles,
    pendingReviewCandidates: mergeReviewCandidates(
      state.pendingReviewCandidates,
      result.reviewCandidates,
    ),
  };
  const measurementPath = appendOpenBrainMeasurements(buildOpenBrainGroomingMeasurements(result, {
    generatedAtIso: result.generatedAtIso,
    sinceIso: result.sinceIso,
    ownerAgent: 'eli',
    pendingReviewCount: nextState.pendingReviewCandidates.length,
    dryRun,
  }));

  if (suppressReviewDigest) {
    writeDigestState(nextState);
    process.stdout.write(
      `Groomed ${result.rawCaptureCount} raw captures silently; queued ${result.reviewCandidates.length} decision candidates for daily digest. Measurements: ${measurementPath}\n`,
    );
    return;
  }

  if (silentWhenClean && needsReviewCount === 0) {
    writeDigestState(nextState);
    process.stdout.write(
      `Groomed ${result.rawCaptureCount} raw captures silently (no human review needed). Measurements: ${measurementPath}\n`,
    );
    return;
  }

  if (!hasAnyActivity) {
    writeDigestState(nextState);
    process.stdout.write(`No raw captures since previous run; skipping Discord digest. Measurements: ${measurementPath}\n`);
    return;
  }

  await sendDiscordDigest(result.digest, resolveDigestChannelId());
  writeDigestState({
    ...nextState,
    pendingReviewCandidates: [],
    lastDecisionDigestIso: generatedAtIso,
  });
  process.stdout.write(
    `Sent OB1 grooming digest for ${result.rawCaptureCount} raw captures since ${sinceIso ?? 'previous run'}. Measurements: ${measurementPath}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
