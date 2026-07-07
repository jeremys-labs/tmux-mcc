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

export const DEFAULT_RUNTIME_INBOX_POLL_INTERVAL_MS = 2_000;
/** Upper bound on each channel's delivered-id dedup set on long-lived panes. */
export const DEFAULT_DELIVERED_ID_CAP = 5_000;

/**
 * A dedup set that evicts its oldest entry once it exceeds `max`, so the delivered-id sets on a
 * long-lived pane cannot grow without bound. Insertion order (guaranteed by Set) is eviction order.
 */
export function createBoundedIdSet(max: number): Set<string> {
  const set = new Set<string>();
  const add = set.add.bind(set);
  set.add = (value: string) => {
    add(value);
    if (set.size > max) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
    return set;
  };
  return set;
}

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
