import { afterEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ preloads: 0, starts: 0, stops: 0, failures: 2, active: { error: null as string | null } }));

vi.mock('./workspace.svelte', () => ({ workspace: { active: state.active } }));
vi.mock('./press-preload', () => ({ startPressPreload: () => { state.preloads++; return () => { state.preloads--; }; } }));
vi.mock('./edge-scrollbars', () => ({
  startEdgeScrollbars: () => {
    state.starts++;
    if (state.failures > 0) { state.failures--; throw new Error(`chunk failed to load (${state.starts})`); }
    return () => { state.stops++; };
  }
}));

import { resetFeatures, setFeature } from './features';
import { startInteractions } from './interactions';

afterEach(() => resetFeatures());

test('a switch starts its module, stops it when turned off, and tries again after a failed start', async () => {
  setFeature('edge-scrollbars', false);
  const stop = startInteractions();
  try {
    // Off again before its start failed: that failure is no news.
    setFeature('edge-scrollbars', true);
    setFeature('edge-scrollbars', false);
    await vi.waitFor(() => expect(state.starts).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(state.active.error).toBeNull();
    setFeature('edge-scrollbars', true);
    await vi.waitFor(() => expect(state.active.error).toBe('chunk failed to load (2)'));
    // Turned on again without going off first: the failed start is not counted as running.
    setFeature('edge-scrollbars', true);
    await vi.waitFor(() => expect(state.starts).toBe(3));
    await Promise.resolve();
    setFeature('edge-scrollbars', false);
    await vi.waitFor(() => expect(state.stops).toBe(1));
  } finally { stop(); }
});

test('load on press runs without a switch and stops with the interactions', async () => {
  setFeature('edge-scrollbars', false);
  const stop = startInteractions();
  await vi.waitFor(() => expect(state.preloads).toBe(1));
  stop();
  expect(state.preloads).toBe(0);
});
