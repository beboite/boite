import { beforeEach, describe, expect, test } from 'vitest';
import {
  PANEL_DEFAULT,
  PANEL_MIN,
  PANEL_STORAGE_KEY,
  PANEL_WIDTH_KEY,
  RightPanelStore,
  clampPanel
} from './right-panel.svelte';

function panel(threadId = 't-1') {
  const root = new RightPanelStore();
  return { root, bound: root.for(threadId) };
}

describe('the right panel', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test('opens the panel on the surface it just made', () => {
    const { bound } = panel();

    expect(bound.isOpen).toBe(false);
    const trace = bound.open('trace');

    expect(trace.id).toBe('trace');
    expect(bound.isOpen).toBe(true);
    expect(bound.activeSurfaceId).toBe('trace');
    expect(bound.surfaces).toHaveLength(1);
  });

  test('trace is a singleton, a browser tab is one per id', () => {
    const { bound } = panel();

    bound.open('trace');
    bound.open('trace');
    const first = bound.open('browser');
    const second = bound.open('browser');

    expect(bound.surfaces.map((surface) => surface.kind)).toEqual(['trace', 'browser', 'browser']);
    expect(first.id).not.toBe(second.id);
    expect(first.id.startsWith('browser:')).toBe(true);
  });

  test('closing the active surface activates the one on its left', () => {
    const { bound } = panel();

    const trace = bound.open('trace');
    const left = bound.open('browser');
    const right = bound.open('browser');
    expect(bound.activeSurfaceId).toBe(right.id);

    bound.close(right.id);
    expect(bound.activeSurfaceId).toBe(left.id);

    bound.close(left.id);
    expect(bound.activeSurfaceId).toBe(trace.id);
    expect(bound.isOpen).toBe(true);
  });

  test('closing the last surface closes the panel', () => {
    const { bound } = panel();

    const trace = bound.open('trace');
    bound.close(trace.id);

    expect(bound.surfaces).toHaveLength(0);
    expect(bound.activeSurfaceId).toBe(null);
    expect(bound.isOpen).toBe(false);
  });

  test('close to the right keeps the tab it was asked on and what came before', () => {
    const { bound } = panel();

    const trace = bound.open('trace');
    const middle = bound.open('browser');
    const last = bound.open('browser');

    bound.closeToRight(middle.id);

    expect(bound.surfaces.map((surface) => surface.id)).toEqual([trace.id, middle.id]);
    // The active one was cut, so the tab the menu opened on takes over.
    expect(bound.activeSurfaceId).toBe(middle.id);
    expect(bound.surfaces.some((surface) => surface.id === last.id)).toBe(false);

    bound.closeOthers(trace.id);
    expect(bound.surfaces.map((surface) => surface.id)).toEqual([trace.id]);
    expect(bound.activeSurfaceId).toBe(trace.id);

    bound.closeAll();
    expect(bound.surfaces).toHaveLength(0);
    expect(bound.isOpen).toBe(false);
  });

  test('the trace button opens the panel, then shuts it', () => {
    const { bound } = panel();

    bound.toggleTrace();
    expect(bound.isOpen).toBe(true);
    expect(bound.active?.kind).toBe('trace');

    bound.toggleTrace();
    expect(bound.isOpen).toBe(false);
    // The surfaces stay: reopening comes back to the same strip.
    expect(bound.surfaces).toHaveLength(1);

    bound.toggleTrace();
    expect(bound.isOpen).toBe(true);

    const browser = bound.open('browser');
    bound.toggleTrace();
    expect(bound.isOpen).toBe(true);
    expect(bound.active?.kind).toBe('trace');
    expect(bound.surfaces.some((surface) => surface.id === browser.id)).toBe(true);
  });

  test('a panel comes back from localStorage, thread by thread', () => {
    const first = panel('t-1');
    first.bound.open('trace');
    const browser = first.bound.open('browser');
    first.bound.update(browser.id, { title: 'Boite', url: 'https://example.test/' });
    first.root.for('t-2').open('browser');

    const again = new RightPanelStore();
    const back = again.for('t-1');

    expect(back.isOpen).toBe(true);
    expect(back.activeSurfaceId).toBe(browser.id);
    expect(back.surfaces.map((surface) => surface.kind)).toEqual(['trace', 'browser']);
    expect(back.surfaces[1]?.title).toBe('Boite');
    expect(back.surfaces[1]?.url).toBe('https://example.test/');
    expect(again.for('t-2').surfaces).toHaveLength(1);
    expect(again.for('t-3').surfaces).toHaveLength(0);
  });

  test('a stored blob of another version is dropped whole', () => {
    window.localStorage.setItem(
      PANEL_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        threads: { 't-1': { isOpen: true, activeSurfaceId: 'trace', surfaces: [{ id: 'trace', kind: 'trace' }] } }
      })
    );

    expect(new RightPanelStore().for('t-1').surfaces).toHaveLength(0);

    window.localStorage.setItem(PANEL_STORAGE_KEY, 'not json at all');
    expect(new RightPanelStore().for('t-1').surfaces).toHaveLength(0);
  });

  test('the width is remembered, and clamped to what the layout leaves', () => {
    const { root } = panel();
    expect(root.width).toBe(PANEL_DEFAULT);

    root.width = 520;
    root.saveWidth();
    expect(window.localStorage.getItem(PANEL_WIDTH_KEY)).toBe('520');
    expect(new RightPanelStore().width).toBe(520);

    // 70 percent of the viewport is the ceiling, the chat column's 360 px the other.
    expect(clampPanel(2000, 1400, 280)).toBe(760);
    // A 900 px window with a 280 px sidebar leaves the chat nothing: the floor wins.
    expect(clampPanel(2000, 900, 280)).toBe(PANEL_MIN);
    expect(clampPanel(10, 1400, 280)).toBe(PANEL_MIN);
    expect(clampPanel(400, 1400, 280)).toBe(400);
  });

  test('a thread that leaves takes its panel with it', () => {
    const { root, bound } = panel('t-1');
    bound.open('trace');

    root.forget('t-1');

    expect(root.for('t-1').surfaces).toHaveLength(0);
    expect(new RightPanelStore().for('t-1').surfaces).toHaveLength(0);
  });
});
