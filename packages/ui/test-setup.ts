import { vi } from 'vitest';
import { releaseVersion } from './release-version';

// What Vite's define gives the app (`vite.config.ts`). Set here rather than in
// vitest.config.ts, whose hash keys CI's transform cache: a change there runs
// every pull request on a cold cache.
vi.stubGlobal('__BOITE_VERSION__', releaseVersion());
Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: (media: string) => Object.assign(new EventTarget(), {
  media, matches: false, onchange: null, addListener() {}, removeListener() {}
}) });

// jsdom has no layout. Browser tests cover measured sizes and scrolling.
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

// jsdom's user-agent sheet hides `[popover]:not(:popover-open)`, but jsdom has
// no Popover API and its selector engine never matches `:popover-open`
// (jsdom/jsdom#3721), so every popover counts as display: none. Since jsdom
// 30.1, focus() refuses an element hidden that way. The app only keeps a
// `[popover]` node mounted while it is open (floating.ts, ContextMenu), which a
// browser shows through showPopover(), so here it is shown as one. jsdom
// cascades its user-agent sheet and the page's by specificity alone, so this
// rule repeats the hiding selector to outrank it; `hidden` and an inline
// `display` still win, as in a browser.
const popoverShown = document.createElement('style');
popoverShown.textContent = '[popover]:not(:popover-open):not(dialog[open]):not([hidden]) { display: block; }';
document.head.append(popoverShown);

// Nor a canvas: say so quietly, as a browser without one would, instead of
// jsdom's "not implemented" on every image attached.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

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
