import {
  enqueuePendingRuntimeAgentMail,
  enqueueRuntimeAgentMailMessages,
  isRestartRecoveryAgentMail,
  listRestartRecoveryAgentMail,
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
import {
  enqueuePendingRuntimeEventInbox,
  type EnqueuePendingRuntimeEventInboxInput,
} from './runtime-event-inbox.js';
import type { AgentMailStore } from '@agent-comms/mailbox';

export const DEFAULT_RUNTIME_INBOX_POLL_INTERVAL_MS = 2_000;
export const RESTART_RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const RESTART_RECOVERY_LIMIT = 10;
export { createBoundedIdSet, DEFAULT_DELIVERED_ID_CAP } from './runtime-delivered-ids.js';

type DiscordPollerArgs = Pick<EnqueuePendingRuntimeDiscordInboxInput, 'submitPrompt'>;
type AgentMailPollerArgs = Pick<EnqueuePendingRuntimeAgentMailInput, 'submitPrompt'> & {
  mailStore: EnqueuePendingRuntimeAgentMailInput['mailStore'] & Pick<AgentMailStore, 'getMessage' | 'listEvents'>;
};
type BlueBubblesPollerArgs = Pick<EnqueuePendingRuntimeBlueBubblesInboxInput, 'submitPrompt'>;
type HandoffPollerArgs = Pick<RuntimeHandoffInjectionInput, 'workspace' | 'submitHandoff'>;
type EventInboxPollerArgs = Pick<EnqueuePendingRuntimeEventInboxInput, 'eventInbox' | 'submitPrompt'>;

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
  eventInbox?: EventInboxPollerArgs;
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
    eventInbox,
    intervalMs = DEFAULT_RUNTIME_INBOX_POLL_INTERVAL_MS,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = input;

  const deliveredDiscordIds = createBoundedIdSet(DEFAULT_DELIVERED_ID_CAP);
  const deliveredAgentMailIds = createBoundedIdSet(DEFAULT_DELIVERED_ID_CAP);
  const deliveredBlueBubblesIds = createBoundedIdSet(DEFAULT_DELIVERED_ID_CAP);
  const deliveredEventInboxIds = createBoundedIdSet(DEFAULT_DELIVERED_ID_CAP);

  // The recovery window starts at the first acknowledgement, which redelivery leaves intact.
  // Use the startup time for both selection and revalidation so queue delays cannot age out work.
  const restartRecoveryOptions = {
    nowMs: Date.now(),
    maxAgeMs: RESTART_RECOVERY_MAX_AGE_MS,
  };
  // Snapshot recent, newest-first obligations once per process start. Successful delivery
  // removes an entry; a timeout keeps its id claimed because the detached task may still submit.
  let restartRecoveryMail: Map<string, ReturnType<typeof listRestartRecoveryAgentMail>[number]> | null = null;

  let handoffSettled = false;
  let handoffInFlight = false;
  let postHandoffDiscordContextNeeded = false;

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
          if (outcome === 'delivered') postHandoffDiscordContextNeeded = true;
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
      needsPostHandoffContext: () => postHandoffDiscordContextNeeded,
      markPostHandoffContextLoaded: () => { postHandoffDiscordContextNeeded = false; },
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

    if (restartRecoveryMail === null) {
      restartRecoveryMail = new Map(
        listRestartRecoveryAgentMail(agentMail.mailStore, agentKey, {
          ...restartRecoveryOptions,
          limit: RESTART_RECOVERY_LIMIT,
        })
          .map((message) => [message.id, message]),
      );
    }
    enqueueRuntimeAgentMailMessages({
      agentKey,
      mailStore: agentMail.mailStore,
      deliveredIds: deliveredAgentMailIds,
      events,
      openBrainConfig,
      runtimeLogPath,
      submitPrompt: agentMail.submitPrompt,
      enqueue,
      messages: [...restartRecoveryMail.values()],
      shouldDeliver: (message) => isRestartRecoveryAgentMail(
        agentMail.mailStore,
        agentKey,
        message.id,
        restartRecoveryOptions,
      ),
      deliveryNoticeForMessage: (message) => [
        '[Restart Recovery] This request was delivered before the runtime restarted and still appears unanswered.',
        `Originally created: ${message.createdAt}`,
        'Treat it as recovered work, not a brand-new message.',
      ].join('\n'),
      // A timed-out task keeps running detached. Releasing its id would let the next tick submit
      // the same prompt concurrently. A later process restart can recover a genuinely stuck item.
      releaseOnTimeout: false,
      // Once submitPrompt resolves, retrying after an acknowledgement/logging error duplicates a
      // prompt the runtime already received. Remove it from this process-local recovery snapshot.
      settleAfterSubmitError: true,
      onDelivered: (message) => restartRecoveryMail?.delete(message.id),
    });

    if (eventInbox) {
      enqueuePendingRuntimeEventInbox({
        agentKey,
        eventInbox: eventInbox.eventInbox,
        deliveredIds: deliveredEventInboxIds,
        events,
        runtimeLogPath,
        submitPrompt: eventInbox.submitPrompt,
        enqueue,
      });
    }
  };

  const handle = setIntervalImpl(tick, intervalMs);

  return {
    tick,
    stop() {
      clearIntervalImpl(handle);
    },
  };
}
