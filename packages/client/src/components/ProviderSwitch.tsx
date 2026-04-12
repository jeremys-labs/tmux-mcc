import type { HarnessConfig } from '../types/agent';

type ProviderValue = 'llm' | 'claude-code' | 'codex';

interface Props {
  agentKey: string;
  providerType?: 'llm' | 'persistent-harness';
  harnessConfig?: HarnessConfig;
  defaultCwd: string;
  disabled?: boolean;
  onChange: (providerType: 'llm' | 'persistent-harness', harnessConfig?: HarnessConfig) => void;
}

function toSelectValue(
  providerType?: 'llm' | 'persistent-harness',
  harnessConfig?: HarnessConfig,
): ProviderValue {
  if (providerType === 'persistent-harness' && harnessConfig?.adapter === 'claude-code') return 'claude-code';
  if (providerType === 'persistent-harness' && harnessConfig?.adapter === 'codex') return 'codex';
  return 'llm';
}

export function ProviderSwitch({ providerType, harnessConfig, defaultCwd, disabled, onChange }: Props) {
  const value = toSelectValue(providerType, harnessConfig);

  return (
    <label className="flex items-center gap-2 text-xs text-text-secondary">
      <span>Provider</span>
      <select
        aria-label="Provider"
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value as ProviderValue;
          if (next === 'llm') {
            onChange('llm');
            return;
          }
          onChange('persistent-harness', {
            adapter: next,
            cwd: harnessConfig?.cwd || defaultCwd,
            modelConfig: harnessConfig?.adapter === next ? harnessConfig.modelConfig : undefined,
          });
        }}
        className="rounded-md border border-white/10 bg-surface-overlay px-2 py-1 text-xs text-text-primary"
      >
        <option value="llm">LLM</option>
        <option value="claude-code">Claude Code</option>
        <option value="codex">Codex</option>
      </select>
    </label>
  );
}
