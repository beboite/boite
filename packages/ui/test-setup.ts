import { vi } from 'vitest';

// jsdom has no layout. Browser tests cover measured sizes and scrolling.
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});
