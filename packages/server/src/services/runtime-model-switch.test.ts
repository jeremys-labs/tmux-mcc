import { describe, it, expect } from 'vitest';
import { detectModelSwitch } from './runtime-model-switch.js';

describe('detectModelSwitch', () => {
  it('detects "switch to opus"', () => {
    const result = detectModelSwitch('Switch to Opus');
    expect(result).toEqual({ matched: true, model: 'opus' });
  });

  it('detects "switch to sonnet"', () => {
    const result = detectModelSwitch('switch to sonnet');
    expect(result).toEqual({ matched: true, model: 'sonnet' });
  });

  it('detects "change to haiku"', () => {
    const result = detectModelSwitch('change to haiku');
    expect(result).toEqual({ matched: true, model: 'haiku' });
  });

  it('detects "use opus 4.6"', () => {
    const result = detectModelSwitch('use opus 4.6');
    expect(result).toEqual({ matched: true, model: 'claude-opus-4-6' });
  });

  it('detects "switch model to sonnet"', () => {
    const result = detectModelSwitch('Can you switch model to Sonnet please?');
    expect(result).toEqual({ matched: true, model: 'sonnet' });
  });

  it('detects "set model to opus"', () => {
    const result = detectModelSwitch('set model to opus');
    expect(result).toEqual({ matched: true, model: 'opus' });
  });

  it('detects "switch to fable"', () => {
    const result = detectModelSwitch('Switch to Fable');
    expect(result).toEqual({ matched: true, model: 'claude-fable-5' });
  });

  it('detects "use fable 5"', () => {
    const result = detectModelSwitch('use fable 5');
    expect(result).toEqual({ matched: true, model: 'claude-fable-5' });
  });

  it('detects "switch to opus 4.8"', () => {
    const result = detectModelSwitch('switch to opus 4.8');
    expect(result).toEqual({ matched: true, model: 'opus' });
  });

  it('does not match unrelated messages', () => {
    expect(detectModelSwitch('How is the project going?')).toEqual({ matched: false });
    expect(detectModelSwitch('What model are you running on?')).toEqual({ matched: false });
    expect(detectModelSwitch('The opus of beethoven is great')).toEqual({ matched: false });
    expect(detectModelSwitch('That story is quite a fable')).toEqual({ matched: false });
  });

  it('does not match without a trigger verb', () => {
    expect(detectModelSwitch('opus is better')).toEqual({ matched: false });
    expect(detectModelSwitch('I prefer sonnet')).toEqual({ matched: false });
  });

  it('handles case insensitivity', () => {
    const result = detectModelSwitch('SWITCH TO OPUS');
    expect(result).toEqual({ matched: true, model: 'opus' });
  });

  it('handles surrounding text', () => {
    const result = detectModelSwitch("Hey Zara, can you switch to opus for this task? I need more reasoning power.");
    expect(result).toEqual({ matched: true, model: 'opus' });
  });
});
