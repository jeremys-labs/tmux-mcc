// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProviderSwitch } from './ProviderSwitch';

describe('ProviderSwitch', () => {
  it('renders the current provider and calls onChange with harness config', () => {
    const onChange = vi.fn();

    render(
      <ProviderSwitch
        agentKey="zara"
        providerType="llm"
        harnessConfig={undefined}
        defaultCwd="/Volumes/Repo-Drive/src/openclaw-mcc"
        onChange={onChange}
      />
    );

    fireEvent.change(screen.getByLabelText(/provider/i), {
      target: { value: 'claude-code' },
    });

    expect(onChange).toHaveBeenCalledWith('persistent-harness', {
      adapter: 'claude-code',
      cwd: '/Volumes/Repo-Drive/src/openclaw-mcc',
      modelConfig: undefined,
    });
  });
});
