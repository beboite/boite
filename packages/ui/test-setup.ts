import { vi } from 'vitest';
Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: (media: string) => Object.assign(new EventTarget(), {
  media, matches: false, onchange: null, addListener() {}, removeListener() {}
}) });

// jsdom has no layout. Browser tests cover measured sizes and scrolling.
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

// jsdom has no Web Animations either, so a Svelte transition ends at once here.
if (typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = function animate() {
    const animation = { currentTime: 0, playState: 'finished', onfinish: null as (() => void) | null, cancel() {}, finish() {} };
    queueMicrotask(() => animation.onfinish?.());
    return animation as unknown as Animation;
  };
}

vi.stubGlobal('matchMedia', (media: string) => ({
  media,
  matches: false,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return true; }
}));
