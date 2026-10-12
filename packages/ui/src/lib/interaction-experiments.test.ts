import { afterEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ starts: 0, stops: 0, failures: 2, active: { error: null as string | null } }));

vi.mock('./workspace.svelte', () => ({ workspace: { active: state.active } }));
vi.mock('./press-preload', () => ({ startPressPreload: () => () => undefined }));
vi.mock('./edge-scrollbars', () => ({
  startEdgeScrollbars: () => {
    state.starts++;
    if (state.failures > 0) { state.failures--; throw new Error(`chunk failed to load (${state.starts})`); }
    return () => { state.stops++; };
  }
}));

import { setExperiment, writeExperiments } from './experiments';
import { startInteractionExperiments } from './interaction-experiments';

afterEach(() => writeExperiments([]));

test('a switch starts its module, stops it when turned off, and tries again after a failed start', async () => {
  const stop = startInteractionExperiments();
  try {
    // Off again before its start failed: that failure is no news.
    setExperiment('edge-scrollbars', true);
    setExperiment('edge-scrollbars', false);
    await vi.waitFor(() => expect(state.starts).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(state.active.error).toBeNull();
    setExperiment('edge-scrollbars', true);
    await vi.waitFor(() => expect(state.active.error).toBe('chunk failed to load (2)'));
    // Turned on again without going off first: the failed start is not counted as running.
    setExperiment('edge-scrollbars', true);
    await vi.waitFor(() => expect(state.starts).toBe(3));
    await Promise.resolve();
    setExperiment('edge-scrollbars', false);
    await vi.waitFor(() => expect(state.stops).toBe(1));
  } finally { stop(); }
});
