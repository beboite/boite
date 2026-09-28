import { afterEach, expect, test } from 'vitest';
import { readZoom, stepZoom, ZOOM_DEFAULT, ZOOM_KEY, ZOOM_STEPS, zoomKey } from './zoom';

afterEach(() => localStorage.clear());

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
