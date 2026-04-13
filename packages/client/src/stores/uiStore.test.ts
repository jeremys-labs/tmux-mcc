import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from './uiStore';

describe('uiStore', () => {
  beforeEach(() => {
    useUIStore.setState({ activeView: null, fileSplitOpen: false });
  });

  it('has default state: no view, file split closed', () => {
    const state = useUIStore.getState();
    expect(state.activeView).toBeNull();
    expect(state.fileSplitOpen).toBe(false);
  });

  describe('setView', () => {
    it('changes the active view', () => {
      useUIStore.getState().setView('channels');
      expect(useUIStore.getState().activeView).toBe('channels');
    });
  });

  describe('clearView', () => {
    it('clears the active view', () => {
      useUIStore.getState().setView('office');
      useUIStore.getState().clearView();
      expect(useUIStore.getState().activeView).toBeNull();
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
