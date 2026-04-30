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

    async resolveAnswerContext(agentKey, promptText) {
      const config = resolveOpenBrainRuntimeConfig(agentKey);
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
