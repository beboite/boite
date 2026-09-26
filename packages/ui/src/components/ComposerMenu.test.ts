import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ComposerMenu from './ComposerMenu.svelte';
import type { PaletteItem } from '../lib/palette';

/**
 * The slash menu hangs from the composer box. In the centred draft on a short
 * window a 420 px list ran off the top of the window; it now takes the height
 * it has, or opens below the box when that side is roomier.
 */

let running: Record<string, unknown> | null = null;
const realHeight = window.innerHeight;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: realHeight });
});

const ITEMS: PaletteItem[] = [
  { id: 'a', kind: 'command', label: '/review', description: 'Review the diff' },
  { id: 'b', kind: 'command', label: '/plan', description: 'Plan first' }
];

async function open(anchor: { top: number; bottom: number }, viewport: number): Promise<HTMLElement> {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: viewport });
  const box = document.createElement('div');
  box.getBoundingClientRect = () => ({ top: anchor.top, bottom: anchor.bottom, left: 0, right: 600, width: 600, height: anchor.bottom - anchor.top, x: 0, y: anchor.top, toJSON: () => ({}) });
  document.body.append(box);
  running = mount(ComposerMenu, {
    target: box,
    props: { open: true, items: ITEMS, selected: 0, kind: 'slash', label: 'Commands', empty: 'Nothing', onpick: () => {}, onhover: () => {} }
  });
  flushSync();
  await tick();
  flushSync();
  const menu = box.querySelector<HTMLElement>('[data-testid=slash-menu]');
  if (!menu) throw new Error('no slash menu');
  return menu;
}

test('a composer low in a tall window keeps the whole list above it', async () => {
  const menu = await open({ top: 700, bottom: 780 }, 800);
  expect(menu.classList.contains('below')).toBe(false);
  expect(menu.style.maxHeight).toBe('420px');
});

test('a composer high in a short window opens the list below, never past the top', async () => {
  const menu = await open({ top: 150, bottom: 260 }, 720);
  expect(menu.classList.contains('below')).toBe(true);
  expect(menu.style.maxHeight).toBe('420px');
});

test('with room above but less than the cap, the list above is shortened to fit', async () => {
  const menu = await open({ top: 340, bottom: 470 }, 768);
  expect(menu.classList.contains('below')).toBe(false);
  expect(menu.style.maxHeight).toBe(`${340 - 6 - 8}px`);
});
