import {
  loadPendingRuntimeHandoff,
  markRuntimeHandoffConsumed,
  type PendingRuntimeHandoff,
} from './runtime-handoff.js';
import type { RuntimeEventEmitter } from './runtime-events.js';

export interface RuntimeHandoffInjectionInput {
  workspace: string;
  events: RuntimeEventEmitter;
  submitHandoff: (prompt: string, handoff: PendingRuntimeHandoff) => Promise<void>;
}

export async function injectPendingRuntimeHandoff(input: RuntimeHandoffInjectionInput): Promise<boolean> {
  const handoff = loadPendingRuntimeHandoff(input.workspace);
  const trimmed = handoff?.injectableText.trim() ?? '';
  if (!handoff || !trimmed) return false;

  await input.events.emit('onHandoffLoaded', {
    source: 'runtime_handoff',
    metadata: { cwd: input.workspace },
  });

  await input.submitHandoff(`[Runtime Handoff]\n\n${trimmed}\n`, handoff);
  markRuntimeHandoffConsumed(input.workspace);

  await input.events.emit('onHandoffConsumed', {
    source: 'runtime_handoff',
    metadata: { cwd: input.workspace },
  });

  return true;
}
