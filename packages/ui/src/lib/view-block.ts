/**
 * The frame of a ```view block (`.md-view`, drawn by `lib/rich-markdown-draw.ts`):
 * the page the core serves for its HTML at `VIEW_ROUTE` (`artifacts.viewBlock`),
 * in a sandboxed frame like a page `boite view` publishes (`InlineView.svelte`),
 * handed the app's theme and faces and as tall as the page says it is. It
 * answers `ready` once the page says it is up, and `failed` when it never does
 * or leaves its own address, even after it showed. One message listener and one
 * theme watch serve every frame on screen, so a frame a render drops leaves
 * nothing behind.
 */
import { VIEW_SANDBOX, clampViewHeight, readViewMessage, viewThemeFragment, type ViewHostMessage, type ViewTheme } from '@boite/contracts';
import { openExternal } from './links';
import { viewFonts, viewTheme, watchViewTheme } from './inline-view';
import { strings } from './strings';

/** How long a frame has to load at all, then how long a loaded one has to say it is the page: as for a published view. */
const LOAD_MS = 20_000;
const READY_MS = 2000;
const HEIGHTS_KEPT = 200;

export interface ViewFrameEvents {
  ready: () => void;
  /** Called once, with why the page is not shown. */
  failed: (reason: string) => void;
}

interface FrameState { source: string; loads: number; ready: boolean; done: boolean; timer?: ReturnType<typeof setTimeout>; events: ViewFrameEvents }

const states = new WeakMap<HTMLIFrameElement, FrameState>();
/** The height each block's page last reported, by a hash of its HTML: a block drawn again (a scroll, a remount) waits at its size. */
const heights = new Map<number, number>();
let theme: ViewTheme | null = null;
let watching = false;

function mounted(): HTMLIFrameElement[] {
  return [...document.querySelectorAll<HTMLIFrameElement>('iframe.md-view-frame')];
}

const families = (of: ViewTheme | null): string => `${of?.vars['--font-sans'] ?? ''}|${of?.vars['--font-mono'] ?? ''}`;

/** The page cannot fetch the app's faces: they are handed over as bytes once it is up, and again when the reader picks another. */
function sendFonts(frame: HTMLIFrameElement): void {
  const target = frame.contentWindow;
  if (theme) void viewFonts(theme).then((messages) => { for (const message of messages) target?.postMessage(message, '*'); }, () => {});
}

/** FNV-1a: the key of a height, where a collision costs one placeholder of the wrong height. */
function keyOf(source: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) hash = Math.imul(hash ^ source.charCodeAt(index), 0x01000193);
  return hash >>> 0;
}

/** The height the page of this HTML last had on screen, if it showed. */
export function knownViewHeight(source: string): number | undefined {
  return heights.get(keyOf(source));
}

function remember(source: string, height: number): void {
  const key = keyOf(source);
  heights.delete(key);
  heights.set(key, height);
  if (heights.size > HEIGHTS_KEPT) heights.delete(heights.keys().next().value!);
}

function fail(state: FrameState, reason: string): void {
  clearTimeout(state.timer);
  if (state.done) return;
  state.done = true;
  state.events.failed(reason);
}

function heard(event: MessageEvent): void {
  const frame = mounted().find(item => item.contentWindow === event.source);
  const state = frame ? states.get(frame) : undefined;
  const message = state ? readViewMessage(event.data) : null;
  if (!frame || !state || state.done || !message) return;
  if (message.type === 'size') {
    // A page hidden behind its code has no width: what it measures then is not its height.
    if (frame.closest<HTMLElement>('.md-view')?.dataset.view === 'code') return;
    const height = clampViewHeight(message.height);
    frame.style.height = `${height}px`;
    remember(state.source, height);
  } else if (message.type === 'ready') {
    if (state.ready) return;
    state.ready = true;
    clearTimeout(state.timer);
    frame.dataset.ready = '';
    sendFonts(frame);
    state.events.ready();
  // A page can post without a click: the link opens only from the frame the reader just acted in.
  } else if (document.activeElement === frame && navigator.userActivation?.isActive !== false) {
    void openExternal(message.url).catch(() => {});
  }
}

function watch(): void {
  if (watching) return;
  watching = true;
  window.addEventListener('message', heard);
  // A theme, an accent, a face or the motion setting changed under the pages on screen.
  watchViewTheme(() => {
    const before = families(theme);
    theme = viewTheme();
    const message: ViewHostMessage = { boiteView: 1, type: 'theme', theme };
    for (const frame of mounted()) {
      if (!states.get(frame)?.ready) continue;
      frame.style.colorScheme = theme.scheme;
      frame.contentWindow?.postMessage(message, '*');
      if (families(theme) !== before) sendFonts(frame);
    }
  });
}

/** A frame in `stage` loading `url`, the page of the block whose HTML is `source`. */
export function mountViewFrame(stage: HTMLElement, url: string, source: string, events: ViewFrameEvents): HTMLIFrameElement {
  watch();
  theme ??= viewTheme();
  const frame = document.createElement('iframe');
  const state: FrameState = { source, loads: 0, ready: false, done: false, events };
  states.set(frame, state);
  frame.className = 'md-view-frame';
  frame.title = strings.chat.viewBlock.label;
  frame.setAttribute('sandbox', VIEW_SANDBOX);
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.dataset.testid = 'view-block-frame';
  frame.style.colorScheme = theme.scheme;
  const known = knownViewHeight(source);
  if (known) frame.style.height = `${known}px`;
  frame.addEventListener('load', () => {
    // A second load is the page leaving its own address: it is closed rather than left showing another one.
    if (++state.loads > 1) { fail(state, strings.chat.viewBlock.navigated); return; }
    if (state.ready) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => fail(state, strings.chat.viewBlock.silent), READY_MS);
  });
  state.timer = setTimeout(() => fail(state, strings.chat.viewBlock.timeout), LOAD_MS);
  // The theme rides in the address, so the first paint is already the app's.
  frame.src = `${url}${viewThemeFragment(theme)}`;
  stage.append(frame);
  return frame;
}
