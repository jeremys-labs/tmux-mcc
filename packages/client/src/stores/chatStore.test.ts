import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from './chatStore';

describe('chatStore', () => {
  beforeEach(() => {
    useChatStore.setState({ messages: {}, drafts: {}, streaming: {}, streamBuffer: {} });
  });

  describe('addMessage', () => {
    it('adds a message to the correct agent', () => {
      const msg = { seq: 1, role: 'user' as const, content: 'hello', timestamp: 1000 };
      useChatStore.getState().addMessage('agent-a', msg);

      const messages = useChatStore.getState().messages['agent-a'];
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(msg);
    });

    it('appends to existing messages', () => {
      const msg1 = { seq: 1, role: 'user' as const, content: 'first', timestamp: 1000 };
      const msg2 = { seq: 2, role: 'assistant' as const, content: 'second', timestamp: 2000 };
      useChatStore.getState().addMessage('agent-a', msg1);
      useChatStore.getState().addMessage('agent-a', msg2);

      expect(useChatStore.getState().messages['agent-a']).toHaveLength(2);
      expect(useChatStore.getState().messages['agent-a'][1]).toEqual(msg2);
    });
  });

  describe('setMessages', () => {
    it('replaces all messages for an agent', () => {
      const original = { seq: 1, role: 'user' as const, content: 'old', timestamp: 1000 };
      useChatStore.getState().addMessage('agent-a', original);

      const replacement = [
        { seq: 10, role: 'assistant' as const, content: 'new-1', timestamp: 5000 },
        { seq: 11, role: 'user' as const, content: 'new-2', timestamp: 6000 },
      ];
      useChatStore.getState().setMessages('agent-a', replacement);

      expect(useChatStore.getState().messages['agent-a']).toEqual(replacement);
    });
  });

  describe('setDraft / clearing drafts', () => {
    it('sets a draft for an agent', () => {
      useChatStore.getState().setDraft('agent-a', 'work in progress');
      expect(useChatStore.getState().drafts['agent-a']).toBe('work in progress');
    });

    it('clears a draft by setting empty string', () => {
      useChatStore.getState().setDraft('agent-a', 'some text');
      useChatStore.getState().setDraft('agent-a', '');
      expect(useChatStore.getState().drafts['agent-a']).toBe('');
    });
  });

  describe('setStreaming', () => {
    it('sets streaming flag to true and clears the buffer', () => {
      useChatStore.setState({ streamBuffer: { 'agent-a': 'leftover' } });
      useChatStore.getState().setStreaming('agent-a', true);

      expect(useChatStore.getState().streaming['agent-a']).toBe(true);
      expect(useChatStore.getState().streamBuffer['agent-a']).toBe('');
    });

    it('sets streaming flag to false without resetting buffer', () => {
      useChatStore.setState({ streamBuffer: { 'agent-a': 'partial' } });
      useChatStore.getState().setStreaming('agent-a', false);

      expect(useChatStore.getState().streaming['agent-a']).toBe(false);
      expect(useChatStore.getState().streamBuffer['agent-a']).toBe('partial');
    });
  });

  describe('appendStreamBuffer', () => {
    it('appends content to an empty buffer', () => {
      useChatStore.getState().appendStreamBuffer('agent-a', 'chunk1');
      expect(useChatStore.getState().streamBuffer['agent-a']).toBe('chunk1');
    });

    it('appends content to an existing buffer', () => {
      useChatStore.getState().appendStreamBuffer('agent-a', 'chunk1');
      useChatStore.getState().appendStreamBuffer('agent-a', ' chunk2');
      expect(useChatStore.getState().streamBuffer['agent-a']).toBe('chunk1 chunk2');
    });
  });

  describe('finalizeStream', () => {
    it('clears streaming, clears buffer, and adds assistant message', () => {
      useChatStore.getState().setStreaming('agent-a', true);
      useChatStore.getState().appendStreamBuffer('agent-a', 'partial');

      useChatStore.getState().finalizeStream('agent-a', 'final answer');

      const state = useChatStore.getState();
      expect(state.streaming['agent-a']).toBe(false);
      expect(state.streamBuffer['agent-a']).toBe('');

      const messages = state.messages['agent-a'];
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('assistant');
      expect(messages[0].content).toBe('final answer');
      expect(messages[0].timestamp).toBeTypeOf('number');
    });
  });

  describe('clearMessages', () => {
    it('empties the messages array for the agent', () => {
      const msg = { seq: 1, role: 'user' as const, content: 'hi', timestamp: 1000 };
      useChatStore.getState().addMessage('agent-a', msg);
      useChatStore.getState().clearMessages('agent-a');

      expect(useChatStore.getState().messages['agent-a']).toEqual([]);
    });
  });

  describe('agent isolation', () => {
    it('messages for different agents are independent', () => {
      const msgA = { seq: 1, role: 'user' as const, content: 'for A', timestamp: 1000 };
      const msgB = { seq: 2, role: 'user' as const, content: 'for B', timestamp: 2000 };

      useChatStore.getState().addMessage('agent-a', msgA);
      useChatStore.getState().addMessage('agent-b', msgB);

      expect(useChatStore.getState().messages['agent-a']).toEqual([msgA]);
      expect(useChatStore.getState().messages['agent-b']).toEqual([msgB]);

      useChatStore.getState().clearMessages('agent-a');
      expect(useChatStore.getState().messages['agent-a']).toEqual([]);
      expect(useChatStore.getState().messages['agent-b']).toEqual([msgB]);
    });
  });
});
