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
  enqueuePendingRuntimeEventInbox,
  type EnqueuePendingRuntimeEventInboxInput,
} from './runtime-event-inbox.js';

export const DEFAULT_RUNTIME_INBOX_POLL_INTERVAL_MS = 2_000;

type DiscordPollerArgs = Pick<EnqueuePendingRuntimeDiscordInboxInput, 'submitPrompt'>;
type AgentMailPollerArgs = Pick<EnqueuePendingRuntimeAgentMailInput, 'mailStore' | 'submitPrompt'>;
type BlueBubblesPollerArgs = Pick<EnqueuePendingRuntimeBlueBubblesInboxInput, 'submitPrompt'>;
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
    eventInbox,
    intervalMs = DEFAULT_RUNTIME_INBOX_POLL_INTERVAL_MS,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = input;

  const deliveredDiscordIds = new Set<string>();
  const deliveredAgentMailIds = new Set<string>();
  const deliveredBlueBubblesIds = new Set<string>();
  const deliveredEventInboxIds = new Set<number>();

  const tick = () => {
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
