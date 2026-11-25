import { appendRuntimeLogLine } from './runtime-log.js';
import {
  formatAgentMailForRuntime,
  type AgentMailMessage,
  type AgentMailStore,
} from '@agent-comms/mailbox';
import { buildAnswerContext } from './answer-context.js';
import {
  captureAgentMailMessage,
  type OpenBrainRuntimeConfig,
} from './open-brain-runtime.js';
import {
  runInboundRuntimeTurn,
  type RuntimeEventEmitter,
} from './runtime-events.js';
import type { DeliveredIdSet } from './runtime-delivered-ids.js';
import type { EnqueueOptions } from './runtime-task-queue.js';

export interface RuntimeAgentMailDeliveryInput {
  agentKey: string;
  message: AgentMailMessage;
  mailStore: Pick<AgentMailStore, 'ackMessage'>;
  events: RuntimeEventEmitter;
  submitPrompt: (prompt: string, message: AgentMailMessage) => Promise<void>;
  runtimeLogPath: string;
  openBrainConfig?: OpenBrainRuntimeConfig | null;
}

export interface EnqueuePendingRuntimeAgentMailInput extends Omit<RuntimeAgentMailDeliveryInput, 'message'> {
  mailStore: Pick<AgentMailStore, 'ackMessage' | 'listInbox'>;
  deliveredIds: DeliveredIdSet;
  enqueue: (task: () => Promise<void>, opts?: EnqueueOptions) => void;
}

export interface EnqueueRuntimeAgentMailMessagesInput extends Omit<EnqueuePendingRuntimeAgentMailInput, 'mailStore'> {
  mailStore: Pick<AgentMailStore, 'ackMessage'>;
  messages: AgentMailMessage[];
  shouldDeliver?: (message: AgentMailMessage) => boolean;
  onDelivered?: (message: AgentMailMessage) => void;
}

function appendRuntimeLog(runtimeLogPath: string, line: string): void {
  appendRuntimeLogLine(runtimeLogPath, line);
}

export async function deliverRuntimeAgentMail(input: RuntimeAgentMailDeliveryInput): Promise<void> {
  const { agentKey, message, mailStore, events, submitPrompt, runtimeLogPath, openBrainConfig } = input;

  await runInboundRuntimeTurn({
    emit: events.emit,
    source: 'agent_mail',
    messageId: message.id,
    preparePrompt: async () => {
      if (openBrainConfig) {
        try {
          await captureAgentMailMessage(openBrainConfig, message);
          appendRuntimeLog(runtimeLogPath, `captured mail ${message.id} to open-brain raw_capture`);
        } catch (error) {
          appendRuntimeLog(runtimeLogPath, `open-brain mail capture error ${message.id}: ${String(error)}`);
        }
      }

      const answerContext = await buildAnswerContext({
        agentKey,
        source: 'agent_mail',
        subject: message.subject,
        text: message.bodyMd,
        project: message.relatedProject,
        openBrainConfig,
      }).catch((error) => {
        appendRuntimeLog(runtimeLogPath, `answer-context mail error ${message.id}: ${String(error)}`);
        return '';
      });

      if (answerContext) {
        appendRuntimeLog(runtimeLogPath, `built answer-context for mail ${message.id}`);
      }

      return [answerContext, formatAgentMailForRuntime(message)].filter(Boolean).join('\n\n');
    },
    submitPrompt: (prompt) => submitPrompt(prompt, message),
    acknowledgeDelivery: () => {
      mailStore.ackMessage(agentKey, message.id);
      appendRuntimeLog(runtimeLogPath, `acknowledged mail ${message.id}`);
    },
  });
}

/**
 * Requests acknowledged by the old runtime but never answered remain work after a restart.
 * They are intentionally separate from the normal NEW inbox: acknowledgement records prompt
 * delivery, not completion of a requires-response obligation.
 */
export function listRestartRecoveryAgentMail(
  mailStore: Pick<AgentMailStore, 'listInbox' | 'listEvents'>,
  agentKey: string,
): AgentMailMessage[] {
  return mailStore.listInbox({ agent: agentKey, status: 'acked' }).filter((message) =>
    message.requiresResponse
    && message.fromAgent !== agentKey
    && !mailStore.listEvents(message.id).some((event) => event.eventType === 'replied')
  );
}

export function enqueueRuntimeAgentMailMessages(input: EnqueueRuntimeAgentMailMessagesInput): void {
  for (const message of input.messages) {
    // Self-mail is durable journal state, not work for the sender to process again.
    if (message.fromAgent === input.agentKey) {
      input.mailStore.ackMessage(input.agentKey, message.id);
      appendRuntimeLog(input.runtimeLogPath, `ignored self-addressed mail ${message.id}`);
      continue;
    }
    if (input.deliveredIds.has(message.id)) continue;
    input.deliveredIds.add(message.id);
    input.enqueue(async () => {
      try {
        // Recovery work can be answered or closed while a prior delivery attempt is failing
        // or waiting in the queue. Revalidate at execution time, not only at process startup.
        if (input.shouldDeliver && !input.shouldDeliver(message)) {
          input.deliveredIds.settle?.(message.id);
          input.onDelivered?.(message);
          appendRuntimeLog(input.runtimeLogPath, `skipped resolved mail ${message.id}`);
          return;
        }
        await deliverRuntimeAgentMail({ ...input, message });
        // Delivered and acked (or deliberately re-injected after restart) — safe to let the
        // cap evict this id. The restart controller separately removes recovered work from
        // its process-local retry map only after this delivery succeeds.
        input.deliveredIds.settle?.(message.id);
        input.onDelivered?.(message);
      } catch (error) {
        input.deliveredIds.delete(message.id);
        appendRuntimeLog(input.runtimeLogPath, `mail inject error ${message.id}: ${String(error)}`);
      }
    }, {
      onTimeout: () => {
        // Timed-out delivery never acked (still 'new'); release the id so it is retried.
        input.deliveredIds.delete(message.id);
        appendRuntimeLog(input.runtimeLogPath, `mail inject timeout ${message.id}; releasing for retry`);
      },
    });
  }
}

export function enqueuePendingRuntimeAgentMail(input: EnqueuePendingRuntimeAgentMailInput): void {
  enqueueRuntimeAgentMailMessages({
    ...input,
    messages: input.mailStore.listInbox({ agent: input.agentKey, status: 'new' }),
  });
}
