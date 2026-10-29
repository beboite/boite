import { afterEach, expect, test, vi } from 'vitest';
import { LONG_PRESS_MS, longPress } from './long-press';

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

function row() {
  const node = document.createElement('button');
  document.body.append(node);
  const menus: MouseEvent[] = [];
  node.addEventListener('contextmenu', event => { if (!event.defaultPrevented) menus.push(event); });
  return { node, menus, action: longPress(node) };
}
const pointer = (node: Element, type: string, init: PointerEventInit) =>
  node.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, ...init }));

test('a second finger neither moves nor lifts the first finger off its long press', () => {
  vi.useFakeTimers();
  const { node, menus } = row();
  pointer(node, 'pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 });
  pointer(node, 'pointermove', { pointerId: 2, pointerType: 'touch', isPrimary: false, clientX: 200, clientY: 200 });
  pointer(node, 'pointerup', { pointerId: 2, pointerType: 'touch', isPrimary: false });
  vi.advanceTimersByTime(LONG_PRESS_MS);
  expect(menus.map(event => [event.clientX, event.clientY])).toEqual([[10, 10]]);
});

test('a mouse right click after a long press whose click never came opens its menu', () => {
  vi.useFakeTimers();
  const { node, menus } = row();
  pointer(node, 'pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 });
  vi.advanceTimersByTime(LONG_PRESS_MS);
  pointer(node, 'pointerdown', { pointerId: 3, pointerType: 'mouse', button: 2 });
  node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
  expect(menus.map(event => event.clientX)).toEqual([10, 40]);
});

test('a press outside the accepted elements is left to the platform and swallows no later tap', () => {
  vi.useFakeTimers();
  const block = document.createElement('p');
  const link = document.createElement('a');
  block.append('some text ', link);
  document.body.append(block);
  const menus: EventTarget[] = [];
  block.addEventListener('contextmenu', event => menus.push(event.target!));
  const clicks: EventTarget[] = [];
  block.addEventListener('click', event => clicks.push(event.target!));
  longPress(block, target => target === link);
  pointer(block, 'pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 5, clientY: 5 });
  vi.advanceTimersByTime(LONG_PRESS_MS);
  expect(menus).toEqual([]);
  link.click();
  expect(clicks).toEqual([link]);
  pointer(link, 'pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 5, clientY: 5 });
  vi.advanceTimersByTime(LONG_PRESS_MS);
  expect(menus).toEqual([link]);
});
