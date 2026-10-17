import { afterEach, expect, test, vi } from 'vitest';
import { PRESS_GRACE_MS, startPressPreload } from './press-preload';

function press(target: Element, type: string, init: { pointerId?: number; button?: number; pointerType?: string } = {}): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: init.button ?? 0 });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    isPrimary: { value: true },
    pointerType: { value: init.pointerType ?? 'mouse' }
  });
  target.dispatchEvent(event);
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  Object.defineProperty(navigator, 'webdriver', { value: false, configurable: true });
});

test('a press preloads on the owning machine, a click inside the grace keeps it, a cancel or a stray release gives it back', () => {
  vi.useFakeTimers();
  Object.defineProperty(navigator, 'webdriver', { value: false, configurable: true });
  document.body.innerHTML = `
    <button id="local" data-preload-thread="t-1"><span id="inner">row</span></button>
    <div data-machine-id="m-2"><button id="remote" data-machine-id="m-2" data-preload-thread="t-9">row</button></div>
    <button id="gone" data-machine-id="m-left" data-preload-thread="t-1">row of a machine that left</button>
    <button id="plain">nothing</button>`;
  const released: string[] = [];
  const preloaded: string[] = [];
  const machine = (name: string) => ({ preload: (id: string) => { preloaded.push(`${name}:${id}`); return () => released.push(`${name}:${id}`); } });
  const stop = startPressPreload({ machines: [{ id: 'm-1', store: machine('m-1') }, { id: 'm-2', store: machine('m-2') }], active: machine('m-1') });
  try {
    press(document.getElementById('inner')!, 'pointerdown');
    expect(preloaded).toEqual(['m-1:t-1']);
    press(document.getElementById('inner')!, 'pointerup');
    vi.advanceTimersByTime(PRESS_GRACE_MS - 1);
    expect(released).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(released).toEqual(['m-1:t-1']);

    // A row of another machine goes to that machine's store; a scroll that takes the finger over gives it back at once.
    press(document.getElementById('remote')!, 'pointerdown', { pointerId: 2, pointerType: 'touch' });
    expect(preloaded.at(-1)).toBe('m-2:t-9');
    press(document.getElementById('remote')!, 'pointercancel', { pointerId: 2 });
    expect(released.at(-1)).toBe('m-2:t-9');

    // A secondary button, an unmarked element, a machine no longer connected and a driven browser ask for nothing.
    press(document.getElementById('local')!, 'pointerdown', { button: 2 });
    press(document.getElementById('plain')!, 'pointerdown');
    press(document.getElementById('gone')!, 'pointerdown');
    Object.defineProperty(navigator, 'webdriver', { value: true, configurable: true });
    press(document.getElementById('local')!, 'pointerdown');
    expect(preloaded).toEqual(['m-1:t-1', 'm-2:t-9']);
    window.__BOITE_PRESS_PRELOAD_TEST__ = true;
    press(document.getElementById('local')!, 'pointerdown');
    expect(preloaded.at(-1)).toBe('m-1:t-1');
  } finally {
    delete window.__BOITE_PRESS_PRELOAD_TEST__;
    stop();
  }
  // Stopping the experiment releases the press still held.
  expect(released.at(-1)).toBe('m-1:t-1');
  press(document.getElementById('local')!, 'pointerdown');
  expect(preloaded).toHaveLength(3);
});
