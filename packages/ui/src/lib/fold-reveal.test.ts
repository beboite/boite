import { afterEach, expect, test, vi } from 'vitest';
import { revealFold } from './fold-reveal';

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });

/** A list scrolled to its end, a fold opening 120 px past its bottom edge, and frames run by hand. */
function opening() {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => { frames.length = 0; });
  document.body.innerHTML = '<div class="list" style="overflow-y: auto"><section><button class="header">Other projects</button></section></div>';
  const scroller = document.querySelector<HTMLElement>('.list')!;
  const section = document.querySelector('section')!;
  const header = document.querySelector<HTMLElement>('.header')!;
  let height = 220;
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 300, 300);
  // The fold's bottom sits past the edge by what the list has not scrolled yet.
  section.getBoundingClientRect = () => new DOMRect(0, 200 - scroller.scrollTop, 300, height);
  scroller.scrollTo = ((options: ScrollToOptions) => { scroller.scrollTop = options.top ?? 0; }) as typeof scroller.scrollTo;
  const frame = (time = performance.now()) => { const pending = frames.splice(0); for (const callback of pending) callback(time); };
  return { scroller, header, frame, setHeight: (value: number) => { height = value; } };
}

test('a scrolling key or a press on the list hands it back to the user', () => {
  for (const hand of [
    (header: HTMLElement) => header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })),
    (header: HTMLElement) => header.dispatchEvent(new Event('pointerdown', { bubbles: true })),
  ]) {
    const { scroller, header, frame } = opening();
    revealFold(header);
    frame();
    expect(scroller.scrollTop).toBe(120);
    scroller.scrollTop = 40;
    hand(header);
    frame();
    expect(scroller.scrollTop).toBe(40);
  }
  // Any other key leaves the list following the fold.
  const { scroller, header, frame } = opening();
  revealFold(header);
  header.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  frame();
  expect(scroller.scrollTop).toBe(120);
});

test('rows loaded after opening become visible unless the user takes over or closes the fold', async () => {
  for (const cancel of ['none', 'pointer', 'close']) {
    const { scroller, header, frame, setHeight } = opening();
    setHeight(20);
    let loaded!: () => void;
    const ready = new Promise<void>(resolve => { loaded = resolve; });
    const stop = revealFold(header, 700, ready);
    // The rows arrive after the opening animation would already have ended.
    frame(performance.now() + 1000);
    expect(scroller.scrollTop).toBe(0);
    if (cancel === 'pointer') header.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    if (cancel === 'close') stop();
    setHeight(220);
    loaded();
    await ready;
    frame();
    expect(scroller.scrollTop).toBe(cancel === 'none' ? 120 : 0);
    stop();
  }
});
