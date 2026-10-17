import { afterEach, expect, test } from 'vitest';
import { watchBrowserBounds } from './browser-bounds';

function box(el: HTMLElement, x: number, y: number, width: number, height: number): HTMLElement {
  el.getBoundingClientRect = () => ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;
  document.body.append(el);
  return el;
}

afterEach(() => { document.body.replaceChildren(); });

test('a decorative full-window layer leaves the page in place, a menu over it parks it', async () => {
  // The edge scrollbars' top layer: a popover over the whole window, hidden from assistive tech.
  const layer = document.createElement('div');
  layer.setAttribute('role', 'dialog');
  layer.setAttribute('aria-hidden', 'true');
  box(layer, 0, 0, 1920, 1080);
  const slot = box(document.createElement('div'), 1100, 100, 800, 900);
  const covered: boolean[] = [];
  const stop = watchBrowserBounds(slot, (rect, value) => { if (rect) covered.push(value); });
  expect(covered).toEqual([false]);

  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  box(menu, 1200, 200, 200, 300);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(covered.at(-1)).toBe(true);

  menu.remove();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(covered.at(-1)).toBe(false);
  stop();
});
