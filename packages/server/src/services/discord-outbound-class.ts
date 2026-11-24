/**
 * The outbound-class vocabulary the discord-bridge policy gate expects, plus the
 * two pure pieces the reply CLI needs around it.
 *
 * This list is a COPY of the bridge's own `OUTBOUND_CLASSES`
 * (agent-comms/packages/discord-bridge/src/services/outbound-policy.ts). mcc-tmux
 * does not depend on that package's source, so the duplication is deliberate --
 * and `rejectsAnUnknownClassLocally` below is what keeps a typo from reaching the
 * socket, where it would come back as a 400 the sender has to decode.
 */
export const OUTBOUND_CLASSES = [
  'interactive_reply',
  'scheduled_digest',
  'alert',
  'system_monitor',
] as const;

export type OutboundClass = typeof OUTBOUND_CLASSES[number];

export function isOutboundClass(value: unknown): value is OutboundClass {
  return typeof value === 'string' && (OUTBOUND_CLASSES as readonly string[]).includes(value);
}

export type PolicyRefusal = {
  error: 'outbound_policy_denied';
  ruleIds?: string[];
  violations?: Array<{ ruleId?: string; message?: string; repair?: string }>;
  repair?: string;
  limitation?: string;
};

export function parsePolicyRefusal(responseBody: string): PolicyRefusal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed as { error?: unknown };
  if (candidate.error !== 'outbound_policy_denied') return null;
  return parsed as PolicyRefusal;
}

/**
 * Turn a refusal into something the SENDER can act on without reading JSON.
 *
 * The bridge already computes the rule ids, the per-violation repair and its own
 * stated limitation; throwing that away and printing a stack trace is how a
 * refusal becomes indistinguishable from a crash. Same defect, and same fix, as
 * the agent-mail refusal path (dc-20261122-102).
 */
export function formatPolicyRefusal(refusal: PolicyRefusal): string {
  const lines = ['REFUSED by the Discord outbound policy. The message was NOT sent.'];
  for (const violation of refusal.violations ?? []) {
    const ruleId = violation.ruleId ?? 'unknown rule';
    lines.push(`  - ${ruleId}: ${violation.message ?? '(no message)'}`);
    if (violation.repair) lines.push(`    fix: ${violation.repair}`);
  }
  if ((refusal.violations ?? []).length === 0 && (refusal.ruleIds ?? []).length > 0) {
    lines.push(`  - rules: ${(refusal.ruleIds ?? []).join(', ')}`);
  }
  if (refusal.repair) lines.push(refusal.repair);
  if (refusal.limitation) lines.push(`Known limitation: ${refusal.limitation}`);
  return lines.join('\n');
}


export type ClassDecision = {
  outboundClass: OutboundClass;
  /** 'declared' = a human or caller passed --outbound-class. 'inferred' = derived from the environment. */
  origin: 'declared' | 'inferred';
  /** The scheduler job id the inference was based on, when there was one. */
  scheduledJobId?: string;
};

/**
 * Decide the class, and SAY WHICH WAY IT WAS DECIDED.
 *
 * Isla's ruling (msg_6cec94e6) after I measured that 15 of 17 live scheduled
 * jobs bake the CLI command into their own prompt text: an explicit flag would
 * need 15 prompt edits across four owners, and ANY ONE MISSED refuses its send
 * silently -- starting with the 07:45 newsletter. So an absent flag infers
 * `scheduled_digest` when the scheduler's own SCHEDULED_JOB_ID is in the
 * environment, which `scheduler-firing.ts:1188` sets on the single agent-turn
 * spawn that every scheduled job passes through.
 *
 * THE COST, STATED RATHER THAN SOFTENED: this is identity-from-environment. An
 * agent woken BY a cron that then answers a live Discord message in the same
 * turn would have that interactive reply classed as a digest and skip the
 * plain-English check. That case is NARROW but real, which is why `origin` is
 * returned and journalled: an inferred classification is visible rather than
 * silent, the same bargain already accepted for `--sender-kind system`.
 */
export function decideOutboundClass(
  declared: OutboundClass | undefined,
  env: { SCHEDULED_JOB_ID?: string } = {},
): ClassDecision {
  if (declared) {
    return { outboundClass: declared, origin: 'declared' };
  }
  const jobId = (env.SCHEDULED_JOB_ID ?? '').trim();
  if (jobId) {
    return { outboundClass: 'scheduled_digest', origin: 'inferred', scheduledJobId: jobId };
  }
  return { outboundClass: 'interactive_reply', origin: 'inferred' };
}
