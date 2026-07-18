import fs from 'fs';
import {
  formatInboxEntryForCodex,
  markInboxEntryDelivered,
  readPendingInboxEntries,
} from './codex-inbox.js';
import { buildAnswerContext, hasRecentScheduledDiscordContext } from './answer-context.js';
import {
  buildFastAnswerContext,
  classifyIntentLane,
  fastContextEnabled,
  recordDiscordTurnLatency,
} from './discord-fast-lane.js';
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

      const laneDecision = classifyIntentLane({
        text: entry.content,
        hasAttachments: (entry.attachments?.length ?? 0) > 0,
        ...(entry.referencedMessageId ? { referencedMessageId: entry.referencedMessageId } : {}),
      });
      // Eli P1 guard: replies to scheduled/agent-initiated prompts often carry
      // no Discord reply reference — if the full context would include recent
      // scheduled-outbox records for this chat, force the full path.
      const scheduledContextPending =
        laneDecision.lane === 'fast_chat' &&
        hasRecentScheduledDiscordContext(agentKey, entry.channelId, new Date(), entry.referencedMessageId);
      const fastPathUsed =
        laneDecision.lane === 'fast_chat' &&
        !scheduledContextPending &&
        fastContextEnabled(agentKey, process.env);
      if (scheduledContextPending) {
        appendRuntimeLog(runtimeLogPath, `fast lane suppressed for discord ${entry.id}: recent scheduled outbox context`);
      }
      const contextStart = Date.now();

      let answerContext = '';
      if (fastPathUsed) {
        try {
          answerContext = buildFastAnswerContext({ agentKey, source: 'discord', text: entry.content });
        } catch (error) {
          appendRuntimeLog(runtimeLogPath, `fast-context discord error ${entry.id}: ${String(error)}; falling back to full context`);
        }
      }
      if (!answerContext) {
        answerContext = await buildAnswerContext({
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
      }

      try {
        recordDiscordTurnLatency(
          {
            agentKey,
            messageId: entry.id,
            chatId: entry.channelId,
            lane: laneDecision.lane,
            fastPathUsed,
            answerContextMs: Date.now() - contextStart,
            contextBytes: Buffer.byteLength(answerContext),
          },
          process.env.DISCORD_LATENCY_DIR,
        );
      } catch (error) {
        appendRuntimeLog(runtimeLogPath, `latency telemetry error ${entry.id}: ${String(error)}`);
      }

      if (answerContext) {
        appendRuntimeLog(
          runtimeLogPath,
          `built answer-context for discord ${entry.id} lane=${laneDecision.lane}${fastPathUsed ? ' fast' : ''} (${laneDecision.reasons.join(',')})`,
        );
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
