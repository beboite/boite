import { expect, test, vi } from 'vitest';
import { startViewport } from './viewport';

test('keyboard resize and scroll update the visible area and cleanup removes listeners', () => {
  const viewport = new EventTarget() as EventTarget & { height: number; offsetTop: number };
  viewport.height = 800;
  viewport.offsetTop = 0;
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 800);
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
  const stop = startViewport();
  viewport.height = 450;
  viewport.offsetTop = 20;
  viewport.dispatchEvent(new Event('resize'));
  expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('450px');
  expect(document.documentElement.style.getPropertyValue('--app-top')).toBe('20px');
  expect(document.documentElement.dataset.keyboard).toBe('open');
  stop();
  viewport.dispatchEvent(new Event('scroll'));
  expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('');
  vi.unstubAllGlobals();
});
