import { expect, test } from 'vitest';
import { fitBrowserViewport } from './browser-viewport';
import { containPanel, resizePanel, RESIZE_DIRECTIONS } from './floating-panel';

test('a large test resolution fits entirely, while automatic mode fills its slot', () => {
  const slot = { x: 500, y: 100, width: 480, height: 600 };
  const fitted = fitBrowserViewport(slot, { width: 1920, height: 1080 });
  expect(fitted).toEqual({ scale: .25, rect: { x: 500, y: 265, width: 480, height: 270 } });
  expect(fitBrowserViewport(slot, null).rect).toEqual(slot);
});

test('all eight resize directions anchor the opposite edges at the minimum size and app boundary', () => {
  const bounds = { x: 8, y: 52, width: 1200, height: 700 };
  const start = { x: 200, y: 200, width: 600, height: 400 };
  for (const direction of RESIZE_DIRECTIONS) {
    const west = direction.includes('w'), east = direction.includes('e');
    const north = direction.includes('n'), south = direction.includes('s');
    const small = resizePanel(start, west ? 2000 : -2000, north ? 2000 : -2000, direction, bounds);
    expect(small).toEqual({ x: west ? 440 : 200, y: north ? 360 : 200,
      width: west || east ? 360 : 600, height: north || south ? 240 : 400 });
    const large = resizePanel(start, west ? -2000 : 2000, north ? -2000 : 2000, direction, bounds);
    expect(large.x).toBe(west ? 8 : 200);
    expect(large.y).toBe(north ? 52 : 200);
    expect(large.x + large.width).toBe(east ? 1208 : 800);
    expect(large.y + large.height).toBe(south ? 752 : 600);
  }
});

test('dragging beyond the app and shrinking the app keep the whole popup reachable', () => {
  const bounds = { x: 8, y: 52, width: 1200, height: 700 };
  expect(containPanel({ x: -300, y: 2000, width: 600, height: 400 }, bounds)).toEqual({ x: 8, y: 352, width: 600, height: 400 });
  expect(containPanel({ x: 800, y: 500, width: 600, height: 400 }, { x: 0, y: 44, width: 390, height: 300 })).toEqual({ x: 0, y: 44, width: 390, height: 300 });
});
