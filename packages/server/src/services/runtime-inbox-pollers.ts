import {
  enqueuePendingRuntimeAgentMail,
  type EnqueuePendingRuntimeAgentMailInput,
} from './runtime-agent-mail.js';
import {
  enqueuePendingRuntimeBlueBubblesInbox,
  type EnqueuePendingRuntimeBlueBubblesInboxInput,
} from './runtime-bluebubbles-inbox.js';
import {
  enqueuePendingRuntimeDiscordInbox,
  type EnqueuePendingRuntimeDiscordInboxInput,
} from './runtime-discord-inbox.js';
import {
  injectPendingRuntimeHandoff,
  type RuntimeHandoffInjectionInput,
} from './runtime-handoff-injection.js';
import { createBoundedIdSet, DEFAULT_DELIVERED_ID_CAP } from './runtime-delivered-ids.js';

export const DEFAULT_RUNTIME_INBOX_POLL_INTERVAL_MS = 2_000;
export { createBoundedIdSet, DEFAULT_DELIVERED_ID_CAP } from './runtime-delivered-ids.js';

type DiscordPollerArgs = Pick<EnqueuePendingRuntimeDiscordInboxInput, 'submitPrompt'>;
type AgentMailPollerArgs = Pick<EnqueuePendingRuntimeAgentMailInput, 'mailStore' | 'submitPrompt'>;
type BlueBubblesPollerArgs = Pick<EnqueuePendingRuntimeBlueBubblesInboxInput, 'submitPrompt'>;
type HandoffPollerArgs = Pick<RuntimeHandoffInjectionInput, 'workspace' | 'submitHandoff'>;

export interface RuntimeInboxPollersInput {
  agentKey: string;
  contentRoot: string;
  events: EnqueuePendingRuntimeDiscordInboxInput['events'];
  openBrainConfig: EnqueuePendingRuntimeDiscordInboxInput['openBrainConfig'];
  runtimeLogPath: string;
  enqueue: EnqueuePendingRuntimeDiscordInboxInput['enqueue'];
  discord: DiscordPollerArgs;
  agentMail: AgentMailPollerArgs;
  blueBubbles: BlueBubblesPollerArgs;
  /**
   * Optional pending-handoff injection. When present, each tick re-attempts the handoff
   * until it is delivered (or there is nothing pending). A deferred attempt — the injection
   * window never opened — is retried on the next tick rather than dropped.
   */
  handoff?: HandoffPollerArgs;
  intervalMs?: number;
  /** Override for the underlying timer (test seam). */
  setIntervalImpl?: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalImpl?: (handle: NodeJS.Timeout) => void;
}

export interface RuntimeInboxPollerHandle {
  stop(): void;
  /** Run one poll cycle immediately (used by tests and lifecycle warm-up). */
  tick(): void;
}

export function startRuntimeInboxPollers(input: RuntimeInboxPollersInput): RuntimeInboxPollerHandle {
  const {
    agentKey,
    contentRoot,
    events,
    openBrainConfig,
    runtimeLogPath,
    enqueue,
    discord,
    agentMail,
    blueBubbles,
    handoff,
    intervalMs = DEFAULT_RUNTIME_INBOX_POLL_INTERVAL_MS,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = input;

  const deliveredDiscordIds = createBoundedIdSet(DEFAULT_DELIVERED_ID_CAP);
  const deliveredAgentMailIds = createBoundedIdSet(DEFAULT_DELIVERED_ID_CAP);
  const deliveredBlueBubblesIds = createBoundedIdSet(DEFAULT_DELIVERED_ID_CAP);

  let handoffSettled = false;
  let handoffInFlight = false;

  const tick = () => {
    if (handoff && !handoffSettled && !handoffInFlight) {
      handoffInFlight = true;
      enqueue(async () => {
        try {
          const outcome = await injectPendingRuntimeHandoff({
            workspace: handoff.workspace,
            events,
            submitHandoff: handoff.submitHandoff,
          });
          // Only a deferred attempt (window never opened) is worth retrying.
          if (outcome !== 'deferred') handoffSettled = true;
        } catch {
          // Submit threw — leave the file and retry on the next tick.
        } finally {
          handoffInFlight = false;
        }
      }, {
        // A timed-out attempt is abandoned before the finally runs; release the in-flight flag
        // here so the handoff is retried instead of wedged as permanently in flight.
        onTimeout: () => { handoffInFlight = false; },
      });
    }

    enqueuePendingRuntimeBlueBubblesInbox({
      agentKey,
      contentRoot,
      deliveredIds: deliveredBlueBubblesIds,
      events,
      openBrainConfig,
      runtimeLogPath,
      submitPrompt: blueBubbles.submitPrompt,
      enqueue,
    });

    enqueuePendingRuntimeDiscordInbox({
      agentKey,
      contentRoot,
      deliveredIds: deliveredDiscordIds,
      events,
      openBrainConfig,
      runtimeLogPath,
      submitPrompt: discord.submitPrompt,
      enqueue,
    });

    enqueuePendingRuntimeAgentMail({
      agentKey,
      mailStore: agentMail.mailStore,
      deliveredIds: deliveredAgentMailIds,
      events,
      openBrainConfig,
      runtimeLogPath,
      submitPrompt: agentMail.submitPrompt,
      enqueue,
    });
  };

  const handle = setIntervalImpl(tick, intervalMs);

  return {
    tick,
    stop() {
      clearIntervalImpl(handle);
    },
  };
}
