import {
  loadPendingRuntimeHandoff,
  markRuntimeHandoffConsumed,
  type PendingRuntimeHandoff,
} from './runtime-handoff.js';
import type { RuntimeEventEmitter } from './runtime-events.js';

/**
 * - `delivered`: the handoff was submitted through the runtime and the file was consumed.
 * - `deferred`: submit reported it was NOT delivered (e.g. readiness gate never opened);
 *   the file is left in place so a later poll or a restart retries it.
 * - `empty`: no pending handoff to inject.
 */
export type RuntimeHandoffInjectionOutcome = 'delivered' | 'deferred' | 'empty';

export interface RuntimeHandoffInjectionInput {
  workspace: string;
  events: RuntimeEventEmitter;
  /**
   * Submit the handoff to the runtime. Return `false` to signal the handoff was NOT
   * delivered (e.g. the injection window never opened) so the file is left for retry.
   * Returning `void`/`true` — or throwing — keeps the prior contract: void/true consumes,
   * a throw leaves the file untouched.
   */
  submitHandoff: (prompt: string, handoff: PendingRuntimeHandoff) => Promise<boolean | void>;
}

export async function injectPendingRuntimeHandoff(
  input: RuntimeHandoffInjectionInput,
): Promise<RuntimeHandoffInjectionOutcome> {
  const handoff = loadPendingRuntimeHandoff(input.workspace);
  const trimmed = handoff?.injectableText.trim() ?? '';
  if (!handoff || !trimmed) return 'empty';

  await input.events.emit('onHandoffLoaded', {
    source: 'runtime_handoff',
    metadata: { cwd: input.workspace },
  });

  const delivered = await input.submitHandoff(`[Runtime Handoff]\n\n${trimmed}\n`, handoff);
  if (delivered === false) {
    // Not delivered through the runtime — leave the file so a later poll/restart retries.
    return 'deferred';
  }

  markRuntimeHandoffConsumed(input.workspace);

  await input.events.emit('onHandoffConsumed', {
    source: 'runtime_handoff',
    metadata: { cwd: input.workspace },
  });

  return 'delivered';
}
