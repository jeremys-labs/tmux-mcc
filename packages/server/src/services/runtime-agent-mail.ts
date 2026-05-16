import fs from 'fs';
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
  deliveredIds: Set<string>;
  enqueue: (task: () => Promise<void>) => void;
}

function appendRuntimeLog(runtimeLogPath: string, line: string): void {
  fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} ${line}\n`);
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

export function enqueuePendingRuntimeAgentMail(input: EnqueuePendingRuntimeAgentMailInput): void {
  const pendingMail = input.mailStore.listInbox({ agent: input.agentKey, status: 'new' });
  for (const message of pendingMail) {
    if (input.deliveredIds.has(message.id)) continue;
    input.deliveredIds.add(message.id);
    input.enqueue(async () => {
      try {
        await deliverRuntimeAgentMail({ ...input, message });
      } catch (error) {
        input.deliveredIds.delete(message.id);
        appendRuntimeLog(input.runtimeLogPath, `mail inject error ${message.id}: ${String(error)}`);
      }
    });
  }
}
