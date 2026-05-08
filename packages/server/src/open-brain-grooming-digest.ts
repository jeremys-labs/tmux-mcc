import { readDigestState, resolveDigestChannelId, sendDiscordDigest, writeDigestState } from './services/open-brain-grooming-digest.js';
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
  const nextState = {
    ...state,
    lastRunIso: generatedAtIso,
    classifierFailureCycles: result.classifierFailureCycles,
    pendingReviewCandidates: mergeReviewCandidates(
      state.pendingReviewCandidates,
      result.reviewCandidates,
    ),
  };

  if (suppressReviewDigest) {
    writeDigestState(nextState);
    process.stdout.write(
      `Groomed ${result.rawCaptureCount} raw captures silently; queued ${result.reviewCandidates.length} decision candidates for daily digest.\n`,
    );
    return;
  }

  if (silentWhenClean && needsReviewCount === 0) {
    writeDigestState(nextState);
    process.stdout.write(
      `Groomed ${result.rawCaptureCount} raw captures silently (no human review needed).\n`,
    );
    return;
  }

  if (!hasAnyActivity) {
    writeDigestState(nextState);
    process.stdout.write('No raw captures since previous run; skipping Discord digest.\n');
    return;
  }

  await sendDiscordDigest(result.digest, resolveDigestChannelId());
  writeDigestState({
    ...nextState,
    pendingReviewCandidates: [],
    lastDecisionDigestIso: generatedAtIso,
  });
  process.stdout.write(
    `Sent OB1 grooming digest for ${result.rawCaptureCount} raw captures since ${sinceIso ?? 'previous run'}.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
