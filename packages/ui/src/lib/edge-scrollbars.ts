/*
 * Edge scrollbars, the `edge-scrollbars` feature. `interactions.ts`
 * starts this while the switch is on and calls the returned stop when it goes off.
 *
 * Native scrollbars take no room while it runs: the `edge-scrollbars` class on
 * <html> hides them (app.css), so a centred column stays centred. One overlay
 * then draws a thumb for each scroll container under the mouse, on the edge
 * the pointer approaches, fading in from `REVEAL_DISTANCE` px away to full at
 * `FULL_DISTANCE` px. A thumb drags like a native one.
 *
 * Thumbs live in two overlays. A container outside the top layer draws in a
 * plain fixed layer under it, so every open menu (`floating.ts`) covers its
 * thumb as it covers the container. A container inside a menu or dialog draws
 * in a manual popover, shown again each time another popover opens so it stays
 * above the newest menu; a thumb there that a menu opened after its own would
 * cover is not drawn. A press on a thumb is stopped
 * before the app sees it and replayed on the scroll container, the target a
 * native scrollbar press has: a menu keeps itself open while its own list is
 * dragged and closes on a press on the chat's thumb, as it does today.
 *
 * Touch-only devices and forced colours keep their native scrollbars: the
 * whole thing runs only while `(hover: hover) and (pointer: fine)` matches
 * and `forced-colors: active` does not. Cost: one passive pointermove on
 * window, coalesced to one frame; computed overflow cached per element; layout
 * read only for the scroll containers on the pointer's path; scroll and wheel
 * listened to only while a thumb shows.
 */

/** Beyond this distance from an edge, in CSS px, its thumb is hidden. */
export const REVEAL_DISTANCE = 128;
/** Within this distance the thumb is fully opaque. */
export const FULL_DISTANCE = 20;
/** The shortest a thumb gets, its transparent border included. */
export const MIN_THUMB = 32;
/** The thumb's box across the scroll axis; its 2 px transparent border leaves a 6 px stripe 2 px off the edge. */
const THICKNESS = 10;
/** Below this opacity a thumb lets the pointer through. */
const LIVE_OPACITY = 0.05;
const POINTER = '(hover: hover) and (pointer: fine)';
const FORCED = '(forced-colors: active)';
const CLASS = 'edge-scrollbars';

type Axis = 'x' | 'y';
const Y = 1;
const X = 2;

/** How opaque a thumb is with the pointer `distance` px inside its edge: a smoothstep from `reveal` down to `full`. */
export function edgeOpacity(distance: number, reveal = REVEAL_DISTANCE, full = FULL_DISTANCE): number {
  if (!(distance < reveal)) return 0;
  if (distance <= full) return 1;
  const t = (reveal - distance) / (reveal - full);
  return t * t * (3 - 2 * t);
}

/**
 * The thumb's length and its offset along a track of `track` px, for a
 * container scrolled to `scroll` out of `scrollSize` with `clientSize` in
 * view. Null when there is nothing to scroll or no room for a thumb.
 */
export function thumbSpan(scroll: number, scrollSize: number, clientSize: number, track: number, min = MIN_THUMB): { length: number; offset: number } | null {
  const range = scrollSize - clientSize;
  if (range < 1 || clientSize <= 0 || track <= 0) return null;
  const length = Math.min(track, Math.max(min, (track * clientSize) / scrollSize));
  const offset = (track - length) * Math.min(1, Math.max(0, scroll / range));
  return { length, offset };
}

/** The scroll position after the thumb moved `delta` px from where a drag started at `startScroll`. */
export function dragScroll(startScroll: number, delta: number, scrollSize: number, clientSize: number, track: number, length: number): number {
  const range = scrollSize - clientSize;
  const room = track - length;
  if (range <= 0 || room <= 0) return startScroll;
  return Math.min(range, Math.max(0, startScroll + (delta * range) / room));
}

/** Starts the scrollbars and returns what turns it off again. Does nothing on a touch-only or forced-colours display. */
export function startEdgeScrollbars(): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const pointer = window.matchMedia(POINTER);
  const forced = window.matchMedia(FORCED);
  let session: (() => void) | null = null;
  const sync = () => {
    const wanted = pointer.matches && !forced.matches;
    if (wanted && !session) session = activate();
    else if (!wanted && session) { session(); session = null; }
  };
  pointer.addEventListener('change', sync);
  forced.addEventListener('change', sync);
  sync();
  return () => {
    pointer.removeEventListener('change', sync);
    forced.removeEventListener('change', sync);
    session?.();
    session = null;
  };
}

interface Bar {
  el: HTMLElement;
  /** The top-layer element the container sits in, null outside the top layer. */
  host: Element | null;
  axis: Axis;
  /** Where the thumb was last drawn, which a drag starts from. */
  track: number;
  length: number;
  scrollSize: number;
  clientSize: number;
}

interface Drag extends Bar {
  thumb: HTMLDivElement;
  pointerId: number;
  start: number;
  startScroll: number;
}

interface Placement {
  bar: Bar;
  opacity: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

function activate(): () => void {
  const root = document.documentElement;
  root.classList.add(CLASS);
  const newLayer = () => {
    const layer = document.createElement('div');
    layer.className = 'edge-scrollbar-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.append(layer);
    return layer;
  };
  /** Under the top layer: the thumbs of containers no menu holds. */
  const base = newLayer();
  /** In the top layer: the thumbs of containers inside a menu or dialog. */
  const upper = newLayer();
  const topLayer = typeof upper.showPopover === 'function';
  if (topLayer) {
    upper.setAttribute('popover', 'manual');
    upper.showPopover();
  }
  /** Open top-layer elements, oldest first, as their toggle events report them. */
  const opened: Element[] = [];
  try {
    for (const el of document.querySelectorAll(':popover-open, dialog:modal')) if (el !== upper) opened.push(el);
  } catch { /* no :popover-open support: nothing is in the top layer */ }

  /** Scroll axes by computed overflow, with the class string they were read under. */
  const axesCache = new WeakMap<Element, { axes: number; className: string | null }>();
  /** The bar each drawn thumb belongs to. */
  const owners = new Map<HTMLDivElement, Bar>();
  /** Thumbs drawn this frame, keyed by container and axis. */
  let drawn = new Map<HTMLElement, Partial<Record<Axis, HTMLDivElement>>>();
  const spare: HTMLDivElement[] = [];

  let x = 0;
  let y = 0;
  let inside = false;
  let target: Element | null = null;
  let pathFrom: Element | null = null;
  let path: HTMLElement[] = [];
  /** The top-layer element holding the containers of `path`, null when none does. */
  let pathHost: Element | null = null;
  let frame = 0;
  let drag: Drag | null = null;
  let watching = false;

  const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };

  function axesOf(el: Element): number {
    const className = el.getAttribute('class');
    const cached = axesCache.get(el);
    if (cached && cached.className === className) return cached.axes;
    const style = getComputedStyle(el);
    const axes = (scrolls(style.overflowY) ? Y : 0) | (scrolls(style.overflowX) ? X : 0);
    axesCache.set(el, { axes, className });
    return axes;
  }

  /** The scroll containers from the hovered element up, stopping at a top-layer element: what lies under it is not under the pointer. */
  function containersFrom(start: Element | null): HTMLElement[] {
    const list: HTMLElement[] = [];
    pathHost = null;
    for (let el = start; el && el !== document.body && el !== root; el = parentOf(el)) {
      if (el instanceof HTMLElement && axesOf(el)) list.push(el);
      if (inTopLayer(el)) { pathHost = el; break; }
    }
    return list;
  }

  /** Whether a top-layer element opened after `host` covers part of the rectangle. */
  function coveredAbove(host: Element, left: number, top: number, width: number, height: number): boolean {
    const index = opened.indexOf(host);
    if (index < 0) return false;
    for (const el of opened.slice(index + 1)) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height && left < r.right && left + width > r.left && top < r.bottom && top + height > r.top) return true;
    }
    return false;
  }

  function measure(el: HTMLElement, host: Element | null, placements: Placement[]) {
    if (!el.isConnected || !el.offsetWidth || !el.offsetHeight) return;
    const axes = axesOf(el);
    const rect = el.getBoundingClientRect();
    const sx = rect.width / el.offsetWidth;
    const sy = rect.height / el.offsetHeight;
    const left = rect.left + el.clientLeft * sx;
    const top = rect.top + el.clientTop * sy;
    const width = el.clientWidth * sx;
    const height = el.clientHeight * sy;
    const over = x >= left && x <= left + width && y >= top && y <= top + height;
    const tall = axes & Y && el.scrollHeight - el.clientHeight >= 1;
    const wide = axes & X && el.scrollWidth - el.clientWidth >= 1;
    for (const axis of ['y', 'x'] as const) {
      if (!(axis === 'y' ? tall : wide)) continue;
      const held = drag?.el === el && drag.axis === axis;
      const opacity = held ? 1 : over ? edgeOpacity(axis === 'y' ? left + width - x : top + height - y) : 0;
      if (opacity <= 0) continue;
      // Both bars stop short of the corner they would share.
      const track = (axis === 'y' ? height : width) - (tall && wide ? THICKNESS : 0);
      const scrollSize = axis === 'y' ? el.scrollHeight : el.scrollWidth;
      const clientSize = axis === 'y' ? el.clientHeight : el.clientWidth;
      const span = thumbSpan(axis === 'y' ? el.scrollTop : el.scrollLeft, scrollSize, clientSize, track);
      if (!span) continue;
      const bar: Bar = { el, host, axis, track, length: span.length, scrollSize, clientSize };
      const placement = axis === 'y'
        ? { bar, opacity, left: left + width - THICKNESS, top: top + span.offset, width: THICKNESS, height: span.length }
        : { bar, opacity, left: left + span.offset, top: top + height - THICKNESS, width: span.length, height: THICKNESS };
      // The base layer is under every menu already; the upper one is over all of them.
      if (host && !held && coveredAbove(host, placement.left, placement.top, placement.width, placement.height)) continue;
      placements.push(placement);
    }
  }

  function draw() {
    frame = 0;
    if (drag) {
      const delta = (drag.axis === 'y' ? y : x) - drag.start;
      const next = dragScroll(drag.startScroll, delta, drag.scrollSize, drag.clientSize, drag.track, drag.length);
      if (drag.axis === 'y') drag.el.scrollTop = next; else drag.el.scrollLeft = next;
    }
    // Every read first, then every write, so the frame lays out once.
    const placements: Placement[] = [];
    if (inside || drag) {
      if (target && !target.isConnected) target = document.elementFromPoint(x, y);
      if (target !== pathFrom) { pathFrom = target; path = containersFrom(target); }
      for (const el of path) measure(el, pathHost, placements);
      if (drag && !path.includes(drag.el)) measure(drag.el, drag.host, placements);
    }
    const next = new Map<HTMLElement, Partial<Record<Axis, HTMLDivElement>>>();
    for (const placement of placements) {
      const { bar } = placement;
      const thumb = drawn.get(bar.el)?.[bar.axis] ?? spare.pop() ?? newThumb();
      const previous = drawn.get(bar.el);
      if (previous) delete previous[bar.axis];
      (next.get(bar.el) ?? next.set(bar.el, {}).get(bar.el)!)[bar.axis] = thumb;
      owners.set(thumb, bar);
      thumb.dataset.axis = bar.axis;
      thumb.style.transform = `translate(${placement.left}px, ${placement.top}px)`;
      thumb.style.width = `${placement.width}px`;
      thumb.style.height = `${placement.height}px`;
      thumb.style.opacity = String(placement.opacity);
      thumb.toggleAttribute('data-live', placement.opacity >= LIVE_OPACITY);
      const layer = bar.host ? upper : base;
      if (thumb.parentNode !== layer) layer.append(thumb);
    }
    for (const thumbs of drawn.values()) {
      for (const thumb of Object.values(thumbs)) {
        // A dragged thumb that has nothing left to scroll goes too, and its drag
        // ends now: the spare thumb may be drawn for another bar this frame.
        if (!thumb) continue;
        owners.delete(thumb);
        if (thumb === drag?.thumb) { drag = null; thumb.removeAttribute('data-active'); }
        thumb.remove();
        spare.push(thumb);
      }
    }
    drawn = next;
    watch(placements.length > 0);
  }

  function newThumb(): HTMLDivElement {
    const thumb = document.createElement('div');
    thumb.className = 'edge-scrollbar-thumb';
    return thumb;
  }

  /** Scrolling and the wheel matter only while a thumb shows. */
  function watch(on: boolean) {
    if (on === watching) return;
    watching = on;
    if (on) {
      document.addEventListener('scroll', schedule, { capture: true, passive: true });
      window.addEventListener('wheel', onwheel, { capture: true, passive: true });
    } else {
      document.removeEventListener('scroll', schedule, true);
      window.removeEventListener('wheel', onwheel, true);
    }
  }

  function onmove(event: PointerEvent) {
    if (event.pointerType === 'touch') { inside = false; schedule(); return; }
    x = event.clientX;
    y = event.clientY;
    inside = true;
    // Over a thumb, keep the containers that drew it.
    const hit = event.target instanceof Element ? event.target : null;
    if (!(hit instanceof HTMLDivElement && owners.has(hit))) target = hit;
    schedule();
  }

  function onout(event: PointerEvent) {
    if (event.relatedTarget !== null) return;
    inside = false;
    target = null;
    schedule();
  }

  function ondown(event: PointerEvent) {
    const thumb = event.target;
    if (!(thumb instanceof HTMLDivElement)) return;
    const bar = owners.get(thumb);
    if (!bar) return;
    event.stopPropagation();
    event.preventDefault();
    if (event.button !== 0) return;
    drag = {
      ...bar,
      thumb,
      pointerId: event.pointerId,
      start: bar.axis === 'y' ? event.clientY : event.clientX,
      startScroll: bar.axis === 'y' ? bar.el.scrollTop : bar.el.scrollLeft,
    };
    thumb.setAttribute('data-active', '');
    try { thumb.setPointerCapture(event.pointerId); } catch { /* the pointer is already gone */ }
    // The press a native scrollbar would have given its container.
    bar.el.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, composed: true,
      clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY,
      pointerId: event.pointerId, pointerType: event.pointerType, isPrimary: event.isPrimary,
      button: event.button, buttons: event.buttons,
      ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey,
    }));
  }

  function onup(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const thumb = drag.thumb;
    drag = null;
    thumb.removeAttribute('data-active');
    if (thumb.hasPointerCapture?.(event.pointerId)) thumb.releasePointerCapture(event.pointerId);
    schedule();
  }

  function onclick(event: MouseEvent) {
    if (event.target instanceof HTMLDivElement && (owners.has(event.target) || event.target === drag?.thumb)) {
      event.stopPropagation();
      event.preventDefault();
    }
  }

  /** The wheel over a thumb scrolls its container, as it would over a native bar. */
  function onwheel(event: WheelEvent) {
    const bar = event.target instanceof HTMLDivElement ? owners.get(event.target) : undefined;
    if (!bar) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bar.clientSize : 1;
    bar.el.scrollBy({ left: event.deltaX * unit, top: event.deltaY * unit });
  }

  function ontoggle(event: Event) {
    const el = event.target;
    // <details> toggles too; only popovers and dialogs enter the top layer.
    if (el === upper || !(el instanceof Element) || !(el.hasAttribute('popover') || el instanceof HTMLDialogElement)) return;
    const index = opened.indexOf(el);
    if (index >= 0) opened.splice(index, 1);
    const open = (event as ToggleEvent).newState === 'open';
    if (open) opened.push(el);
    // A menu opening or closing changes which thumbs it covers.
    pathFrom = null;
    schedule();
    if (!open || !topLayer) return;
    // Shown again, the upper overlay moves above the popover that just opened.
    upper.hidePopover();
    upper.showPopover();
  }

  function onresize() { pathFrom = null; schedule(); }

  // One table, so stop removes exactly what was added.
  const listeners: [EventTarget, string, (event: never) => void, AddEventListenerOptions][] = [
    [window, 'pointermove', onmove, { passive: true }],
    [window, 'pointerout', onout, { passive: true }],
    [window, 'pointerdown', ondown, { capture: true }],
    [window, 'pointerup', onup, { capture: true }],
    [window, 'pointercancel', onup, { capture: true }],
    [window, 'lostpointercapture', onup, { capture: true }],
    [window, 'click', onclick, { capture: true }],
    [window, 'resize', onresize, { passive: true }],
    [document, 'toggle', ontoggle, { capture: true }],
  ];
  for (const [target, type, listener, options] of listeners) target.addEventListener(type, listener as EventListener, options);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (drag?.thumb.hasPointerCapture?.(drag.pointerId)) drag.thumb.releasePointerCapture(drag.pointerId);
    drag = null;
    watch(false);
    for (const [target, type, listener, options] of listeners) target.removeEventListener(type, listener as EventListener, options);
    owners.clear();
    opened.length = 0;
    base.remove();
    upper.remove();
    root.classList.remove(CLASS);
  };
}

function scrolls(overflow: string): boolean {
  return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
}

function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const parent = el.parentNode;
  return parent instanceof ShadowRoot ? parent.host : null;
}

function inTopLayer(el: Element): boolean {
  if (!el.hasAttribute('popover') && !(el instanceof HTMLDialogElement && el.open)) return false;
  try { return el.matches(el.hasAttribute('popover') ? ':popover-open' : ':modal'); } catch { return false; }
}
