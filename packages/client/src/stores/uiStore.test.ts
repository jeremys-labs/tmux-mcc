import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from './uiStore';

describe('uiStore', () => {
  beforeEach(() => {
    useUIStore.setState({ activeView: 'office', activeAgent: null, panelOpen: false });
  });

  it('has default view of office and panel closed', () => {
    const state = useUIStore.getState();
    expect(state.activeView).toBe('office');
    expect(state.panelOpen).toBe(false);
    expect(state.activeAgent).toBeNull();
  });

  describe('setView', () => {
    it('changes the active view', () => {
      useUIStore.getState().setView('channels');
      expect(useUIStore.getState().activeView).toBe('channels');
    });

    it('can switch to files view', () => {
      useUIStore.getState().setView('files');
      expect(useUIStore.getState().activeView).toBe('files');
    });
  });

  describe('openAgentPanel', () => {
    it('sets the agent key and opens the panel', () => {
      useUIStore.getState().openAgentPanel('agent-coder');

      const state = useUIStore.getState();
      expect(state.activeAgent).toBe('agent-coder');
      expect(state.panelOpen).toBe(true);
    });
  });

  describe('closePanel', () => {
    it('closes the panel but keeps activeAgent', () => {
      useUIStore.getState().openAgentPanel('agent-coder');
      useUIStore.getState().closePanel();

      const state = useUIStore.getState();
      expect(state.panelOpen).toBe(false);
      expect(state.activeAgent).toBe('agent-coder');
    });
  });
});
