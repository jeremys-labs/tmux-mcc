import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from './uiStore';

describe('uiStore', () => {
  beforeEach(() => {
    useUIStore.setState({ activeView: null, activeAgent: null, fileSplitOpen: false });
  });

  it('has default state: no view, no agent, file split closed', () => {
    const state = useUIStore.getState();
    expect(state.activeView).toBeNull();
    expect(state.activeAgent).toBeNull();
    expect(state.fileSplitOpen).toBe(false);
  });

  describe('setView', () => {
    it('changes the active view', () => {
      useUIStore.getState().setView('channels');
      expect(useUIStore.getState().activeView).toBe('channels');
    });

    it('does not clear activeAgent', () => {
      useUIStore.getState().setActiveAgent('marcus');
      useUIStore.getState().setView('office');
      expect(useUIStore.getState().activeAgent).toBe('marcus');
      expect(useUIStore.getState().activeView).toBe('office');
    });
  });

  describe('setActiveAgent', () => {
    it('sets the active agent and clears the active view', () => {
      useUIStore.getState().setView('office');
      useUIStore.getState().setActiveAgent('marcus');

      const state = useUIStore.getState();
      expect(state.activeAgent).toBe('marcus');
      expect(state.activeView).toBeNull();
    });
  });

  describe('toggleFileSplit', () => {
    it('toggles fileSplitOpen', () => {
      expect(useUIStore.getState().fileSplitOpen).toBe(false);
      useUIStore.getState().toggleFileSplit();
      expect(useUIStore.getState().fileSplitOpen).toBe(true);
      useUIStore.getState().toggleFileSplit();
      expect(useUIStore.getState().fileSplitOpen).toBe(false);
    });
  });
});
