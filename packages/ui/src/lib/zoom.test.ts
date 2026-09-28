import { afterEach, expect, test, vi } from 'vitest';
import { readZoom, stepZoom, ZOOM_DEFAULT, ZOOM_KEY, ZOOM_STEPS, zoomKey } from './zoom';

const webview = vi.hoisted(() => ({ setZoom: (_factor: number): Promise<void> => Promise.resolve() }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => webview }));

afterEach(() => {
  localStorage.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init);
}

test('a zoom walks the ladder and stops at its ends', () => {
  expect(stepZoom(1, 1)).toBe(1.1);
  expect(stepZoom(1, -1)).toBe(0.9);
  expect(stepZoom(ZOOM_STEPS[0]!, -1)).toBe(ZOOM_STEPS[0]);
  expect(stepZoom(ZOOM_STEPS.at(-1)!, 1)).toBe(ZOOM_STEPS.at(-1));
  // Off the ladder, the walk starts from 100 %.
  expect(stepZoom(1.33, 1)).toBe(1.1);
});

test('Ctrl with plus, minus or zero zooms, whatever the keyboard layout', () => {
  expect(zoomKey(key({ key: '=', ctrlKey: true }))).toBe(1);
  expect(zoomKey(key({ key: '+', ctrlKey: true, shiftKey: true }))).toBe(1);
  expect(zoomKey(key({ key: '-', ctrlKey: true }))).toBe(-1);
  expect(zoomKey(key({ key: '0', metaKey: true }))).toBe(0);
  expect(zoomKey(key({ key: '+' }))).toBeNull();
  expect(zoomKey(key({ key: '+', ctrlKey: true, altKey: true }))).toBeNull();
  expect(zoomKey(key({ key: 'k', ctrlKey: true }))).toBeNull();
});

test('a stored factor off the ladder reads as 100 %', () => {
  localStorage.setItem(ZOOM_KEY, '1.25');
  expect(readZoom()).toBe(1.25);
  localStorage.setItem(ZOOM_KEY, '3');
  expect(readZoom()).toBe(ZOOM_DEFAULT);
});

test('a reset pressed while a step is on its way lands after it', async () => {
  vi.resetModules();
  const zoom = await import('./zoom');
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  const applied: number[] = [];
  const pending: Array<() => void> = [];
  webview.setZoom = (factor) => new Promise((resolve) => pending.push(() => { applied.push(factor); resolve(); }));
  const worn: number[] = [];
  zoom.subscribeZoom((factor) => worn.push(factor));

  const step = zoom.setZoom(zoom.stepZoom(zoom.wantedZoom(), 1));
  const twice = zoom.setZoom(zoom.stepZoom(zoom.wantedZoom(), 1));
  const reset = zoom.setZoom(ZOOM_DEFAULT);
  expect(zoom.wantedZoom()).toBe(ZOOM_DEFAULT);
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  pending.shift()!();
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  pending.shift()!();
  await Promise.all([step, twice, reset]);

  // The first step is on its way when the others come; only the last is sent after it.
  expect(applied).toEqual([1.1, ZOOM_DEFAULT]);
  expect(worn).toEqual([1.1, ZOOM_DEFAULT]);
  expect(zoom.currentZoom()).toBe(ZOOM_DEFAULT);
  expect(localStorage.getItem(ZOOM_KEY)).toBe(String(ZOOM_DEFAULT));
});

test('two quick steps walk two rungs', async () => {
  vi.resetModules();
  const zoom = await import('./zoom');
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  webview.setZoom = () => new Promise((resolve) => setTimeout(resolve, 5));
  await Promise.all([zoom.setZoom(zoom.stepZoom(zoom.wantedZoom(), 1)), zoom.setZoom(zoom.stepZoom(zoom.wantedZoom(), 1))]);
  expect(zoom.currentZoom()).toBe(1.25);
});
