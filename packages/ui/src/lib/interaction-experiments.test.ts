import { afterEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ starts: 0, stops: 0, failFirst: true, active: { error: null as string | null } }));

vi.mock('./workspace.svelte', () => ({ workspace: { active: state.active } }));
vi.mock('./press-preload', () => ({ startPressPreload: () => () => undefined }));
vi.mock('./edge-scrollbars', () => ({
  startEdgeScrollbars: () => {
    state.starts++;
    if (state.failFirst) { state.failFirst = false; throw new Error('chunk failed to load'); }
    return () => { state.stops++; };
  }
}));

import { setExperiment, writeExperiments } from './experiments';
import { startInteractionExperiments } from './interaction-experiments';

afterEach(() => writeExperiments([]));

test('a switch starts its module, stops it when turned off, and tries again after a failed start', async () => {
  const stop = startInteractionExperiments();
  try {
    setExperiment('edge-scrollbars', true);
    await vi.waitFor(() => expect(state.active.error).toBe('chunk failed to load'));
    // Turned on again without going off first: the failed start is not counted as running.
    setExperiment('edge-scrollbars', true);
    await vi.waitFor(() => expect(state.starts).toBe(2));
    await Promise.resolve();
    setExperiment('edge-scrollbars', false);
    await vi.waitFor(() => expect(state.stops).toBe(1));
  } finally { stop(); }
});
