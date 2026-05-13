import {
  extractPromptText,
  formatClaudeAdditionalContext,
  formatCodexSystemMessage,
  inferAgentKey,
  parseOpenBrainHookArgs,
  runOpenBrainHarnessHook as runSharedOpenBrainHarnessHook,
  type OpenBrainHookArgs,
  type OpenBrainHookCommand,
  type OpenBrainHookOutputFormat,
  type RunOpenBrainHookInput,
} from './open-brain-hook-helpers.js';
import { buildAnswerContext, isFreshSessionFirstTurnPayload } from './answer-context.js';
import {
  captureClaudeHookEvent,
  captureClaudePromptEvent,
  formatStartupMemoryForClaude,
  formatStartupMemoryForCodex,
  resolveOpenBrainRuntimeConfig,
  searchStartupMemory,
} from './open-brain-runtime.js';

export {
  extractPromptText,
  formatClaudeAdditionalContext,
  formatCodexSystemMessage,
  inferAgentKey,
  parseOpenBrainHookArgs,
  type OpenBrainHookArgs,
  type OpenBrainHookCommand,
  type OpenBrainHookOutputFormat,
  type RunOpenBrainHookInput,
};

export function shouldSkipWrapperInjectedAnswerContext(agentKey: string, promptText: string): boolean {
  if (agentKey !== 'enzo') return false;
  if (!promptText.includes('[Answer Context] Retrieved before')) return false;
  return promptText.includes('[Agent Mail] New message from') || promptText.includes('[Messaging Gateway] Discord message routed');
}

export async function runOpenBrainHarnessHook(input: RunOpenBrainHookInput): Promise<string> {
  return runSharedOpenBrainHarnessHook(input, {
    async resolveStartupContext(agentKey, _payload, outputFormat) {
      const config = resolveOpenBrainRuntimeConfig(agentKey);
      if (!config) return '';
      const memoryText = await searchStartupMemory(config);
      return outputFormat === 'codex'
        ? formatStartupMemoryForCodex(agentKey, memoryText)
        : formatStartupMemoryForClaude(agentKey, memoryText);
    },

    async resolveAnswerContext(agentKey, promptText, payload) {
      if (shouldSkipWrapperInjectedAnswerContext(agentKey, promptText)) {
        return '';
      }
      const config = resolveOpenBrainRuntimeConfig(agentKey);
      if (config) {
        await captureClaudePromptEvent(config, promptText, payload).catch((error) => {
          process.stderr.write(`[open-brain-hook] prompt capture failed: ${String(error)}\n`);
        });
      }
      return buildAnswerContext({
        agentKey,
        source: 'claude_prompt',
        text: promptText,
        freshSessionFirstTurn: isFreshSessionFirstTurnPayload(payload),
        openBrainConfig: config,
      });
    },

    async captureEvent(agentKey, eventName, payload) {
      const config = resolveOpenBrainRuntimeConfig(agentKey);
      if (!config) return;
      await captureClaudeHookEvent(config, eventName, payload);
    },
  });
}
