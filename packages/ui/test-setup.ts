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
