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
} from '@open-brain/agent-harness-hooks';
import { buildAnswerContext } from './answer-context.js';
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
