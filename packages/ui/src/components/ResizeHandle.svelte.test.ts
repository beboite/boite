import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ResizeHandle from './ResizeHandle.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.innerHTML = '';
  delete document.documentElement.dataset.resizing;
});

function pointer(type: string, init: { clientX?: number; clientY?: number; button?: number }): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

function render(orientation: 'vertical' | 'horizontal') {
  const calls = { move: [] as number[][], end: 0, step: [] as number[], reset: 0 };
  mounted = mount(ResizeHandle, {
    target: document.body,
    props: {
      orientation,
      edge: 'right',
      label: 'Resize',
      testid: 'edge',
      value: 280,
      min: 200,
      max: 400,
      onmove: (delta: number, at: number) => calls.move.push([delta, at]),
      onend: () => calls.end++,
      onstep: (delta: number) => calls.step.push(delta),
      onreset: () => calls.reset++
    }
  });
  flushSync();
  return { handle: document.querySelector<HTMLElement>('[data-testid=edge]')!, calls };
}

test('a drag marks the whole document, reports the distance and ends once; Escape puts it back', () => {
  const { handle, calls } = render('vertical');
  expect(handle.getAttribute('role')).toBe('separator');
  expect(handle.getAttribute('aria-orientation')).toBe('vertical');
  expect(handle.getAttribute('aria-valuenow')).toBe('280');
  expect(handle.tabIndex).toBe(0);

  handle.dispatchEvent(pointer('pointerdown', { clientX: 100 }));
  flushSync();
  // The cursor, the selection and the frames under the pointer follow this mark.
  expect(document.documentElement.dataset.resizing).toBe('col');
  expect(handle.classList.contains('dragging')).toBe(true);
  handle.dispatchEvent(pointer('pointermove', { clientX: 160 }));
  handle.dispatchEvent(pointer('pointerup', { clientX: 160 }));
  flushSync();
  expect(calls.move).toEqual([[60, 160]]);
  expect(calls.end).toBe(1);
  expect(document.documentElement.dataset.resizing).toBeUndefined();

  handle.dispatchEvent(pointer('pointerdown', { clientX: 200 }));
  handle.dispatchEvent(pointer('pointermove', { clientX: 120 }));
  // The focus stays where it was during a pointer drag: Escape reaches the window, not the handle.
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  flushSync();
  expect(calls.move.at(-1)).toEqual([0, 200]);
  expect(calls.end).toBe(2);
  expect(document.documentElement.dataset.resizing).toBeUndefined();
});

test('arrows along its axis step 16 px, Home and a double click reset, a right click does nothing', () => {
  const { handle, calls } = render('horizontal');
  handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  expect(calls.step).toEqual([-16, 16]);
  expect(calls.reset).toBe(2);

  handle.dispatchEvent(pointer('pointerdown', { clientY: 10, button: 2 }));
  flushSync();
  expect(handle.classList.contains('dragging')).toBe(false);
  expect(document.documentElement.dataset.resizing).toBeUndefined();
});
