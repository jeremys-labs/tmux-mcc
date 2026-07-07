import fs from 'fs';
import {
  formatInboxEntryForCodex,
  markInboxEntryDelivered,
  readPendingInboxEntries,
} from './codex-inbox.js';
import { buildAnswerContext } from './answer-context.js';
import {
  captureDiscordInboxEntry,
  type OpenBrainRuntimeConfig,
} from './open-brain-runtime.js';
import {
  runInboundRuntimeTurn,
  type RuntimeEventEmitter,
} from './runtime-events.js';
import type { DeliveredIdSet } from './runtime-delivered-ids.js';
import type { EnqueueOptions } from './runtime-task-queue.js';
import type { CodexBridgeInboxEntry } from '../types/codex-bridge.js';

export interface RuntimeDiscordInboxDeliveryInput {
  agentKey: string;
  contentRoot: string;
  entry: CodexBridgeInboxEntry;
  events: RuntimeEventEmitter;
  submitPrompt: (prompt: string, entry: CodexBridgeInboxEntry) => Promise<void>;
  runtimeLogPath: string;
  openBrainConfig?: OpenBrainRuntimeConfig | null;
}

export interface EnqueuePendingRuntimeDiscordInboxInput extends Omit<RuntimeDiscordInboxDeliveryInput, 'entry'> {
  deliveredIds: DeliveredIdSet;
  enqueue: (task: () => Promise<void>, opts?: EnqueueOptions) => void;
}

function appendRuntimeLog(runtimeLogPath: string, line: string): void {
  fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} ${line}\n`);
}

export async function deliverRuntimeDiscordInbox(input: RuntimeDiscordInboxDeliveryInput): Promise<void> {
  const { agentKey, contentRoot, entry, events, submitPrompt, runtimeLogPath, openBrainConfig } = input;

  await runInboundRuntimeTurn({
    emit: events.emit,
    source: 'discord',
    messageId: entry.id,
    preparePrompt: async () => {
      if (openBrainConfig) {
        try {
          await captureDiscordInboxEntry(openBrainConfig, entry);
          appendRuntimeLog(runtimeLogPath, `captured discord ${entry.id} to open-brain raw_capture`);
        } catch (error) {
          appendRuntimeLog(runtimeLogPath, `open-brain discord capture error ${entry.id}: ${String(error)}`);
        }
      }

      const answerContext = await buildAnswerContext({
        agentKey,
        source: 'discord',
        text: entry.content,
        chatId: entry.channelId,
        messageId: entry.id,
        referencedMessageId: entry.referencedMessageId,
        openBrainConfig,
      }).catch((error) => {
        appendRuntimeLog(runtimeLogPath, `answer-context discord error ${entry.id}: ${String(error)}`);
        return '';
      });

      if (answerContext) {
        appendRuntimeLog(runtimeLogPath, `built answer-context for discord ${entry.id}`);
      }

      return [answerContext, formatInboxEntryForCodex(entry)].filter(Boolean).join('\n\n');
    },
    submitPrompt: (prompt) => submitPrompt(prompt, entry),
    acknowledgeDelivery: () => {
      const delivered = markInboxEntryDelivered(contentRoot, agentKey, entry);
      if (!delivered) {
        throw new Error(`discord cursor ack failed for ${entry.id}`);
      }
      appendRuntimeLog(runtimeLogPath, `submitted ${entry.id}`);
    },
  });
}

export function enqueuePendingRuntimeDiscordInbox(input: EnqueuePendingRuntimeDiscordInboxInput): void {
  const pending = readPendingInboxEntries(input.contentRoot, input.agentKey);
  for (const entry of pending) {
    if (input.deliveredIds.has(entry.id)) continue;
    input.deliveredIds.add(entry.id);
    input.enqueue(async () => {
      try {
        await deliverRuntimeDiscordInbox({ ...input, entry });
        // Delivered and acked (cursor advanced) — safe to let the cap evict this id.
        input.deliveredIds.settle?.(entry.id);
      } catch (error) {
        input.deliveredIds.delete(entry.id);
        appendRuntimeLog(input.runtimeLogPath, `inject error ${entry.id}: ${String(error)}`);
      }
    }, {
      onTimeout: () => {
        // Timed-out delivery never acked (cursor not advanced); release the id so it is retried.
        input.deliveredIds.delete(entry.id);
        appendRuntimeLog(input.runtimeLogPath, `inject timeout ${entry.id}; releasing for retry`);
      },
    });
  }
}
