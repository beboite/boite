/**
 * The one pointer drag of the sidebar: thread rows onto a project, project
 * headers into a new order. Pointer events rather than HTML drag and drop: the
 * desktop shell's native drop (folders dropped to add a project) takes every
 * drag over the window on Windows, so a page's own `dragover` and `drop` never
 * fire there.
 *
 * A mouse drags once it travels a few pixels; a press that does not travel
 * stays a click. A finger or a pen, when the caller allows it, drags only after
 * holding still: a finger that moves first scrolls the list, a tap stays a tap.
 * The list scrolls when the pointer nears its edge, and Escape cancels.
 */

/** Where the dragged element was taken: its width, and the grab point inside it, so the card stays under the pointer. */
export interface DragGrip {
  width: number;
  dx: number;
  dy: number;
}

export interface PointerDragHandlers {
  /** The class the page's root wears while the drag runs. */
  rootClass: string;
  /** Milliseconds a finger or pen holds still before the element lifts; without it only a mouse drags. */
  hold?: number;
  /** The element whose box the card copies; the pressed one by default. */
  lifted?: Element | null;
  /** The drag starts. */
  begin(grip: DragGrip): void;
  /** The pointer is at a point, after a move or a scroll of the list under it. */
  aim(x: number, y: number): void;
  /** A started drag ends: released at a point, or cancelled (null). */
  end(drop: { x: number; y: number } | null): void;
}

/** How far the pointer goes, in pixels, before a press becomes a drag rather than a click, or a hold a scroll. */
const DRAG_THRESHOLD = 5;
/** How close to the list's top or bottom, in pixels, the pointer scrolls it, and how far one frame goes at most. */
const SCROLL_EDGE = 40;
const SCROLL_STEP = 16;

/** One drag at a time: a second finger or a second press waits for the first to end. */
let busy = false;

/** The list the element scrolls in: a drag near its edge scrolls it, as a native drag would. */
function scrollerOf(element: Element | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/** Starts watching a press, from the element's `pointerdown`; `handlers` say what the drag does. */
export function startPointerDrag(event: PointerEvent, handlers: PointerDragHandlers): void {
  const held = event.pointerType !== 'mouse';
  if (busy || event.button !== 0 || (held && handlers.hold === undefined)) return;
  busy = true;
  const startX = event.clientX, startY = event.clientY, pointer = event.pointerId;
  const element = event.currentTarget instanceof Element ? event.currentTarget : null;
  const root = document.documentElement;
  let x = startX, y = startY;
  let dragging = false;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let list: HTMLElement | null = null;
  // Near the list's edge the list scrolls, faster the closer the pointer, and the target follows what comes under it.
  const scroll = (): void => {
    frame = 0;
    if (!dragging || !list) return;
    const box = list.getBoundingClientRect();
    if (box.height === 0) return;
    const depth = y < box.top + SCROLL_EDGE ? y - box.top - SCROLL_EDGE : y > box.bottom - SCROLL_EDGE ? y - box.bottom + SCROLL_EDGE : 0;
    if (depth === 0) return;
    const before = list.scrollTop;
    list.scrollTop += Math.sign(depth) * Math.min(SCROLL_STEP, 2 + Math.abs(depth) / 3);
    if (list.scrollTop !== before) handlers.aim(x, y);
    frame = requestAnimationFrame(scroll);
  };
  const begin = (): void => {
    dragging = true;
    const box = (handlers.lifted ?? element)?.getBoundingClientRect();
    handlers.begin({ width: box?.width || 240, dx: box ? startX - box.left : 16, dy: box ? startY - box.top : 16 });
    list = scrollerOf(element);
    // Held by the element, a drag still ends when the pointer is released outside the window.
    try { element?.setPointerCapture?.(pointer); } catch { /* A pointer already gone: the window's events still end the drag. */ }
    root.classList.add(handlers.rootClass);
    window.getSelection()?.removeAllRanges();
    if (held) navigator.vibrate?.(10);
    handlers.aim(x, y);
  };
  const move = (e: PointerEvent): void => {
    if (e.pointerId !== pointer) return;
    x = e.clientX;
    y = e.clientY;
    if (!dragging) {
      if (Math.hypot(x - startX, y - startY) < DRAG_THRESHOLD) return;
      // A finger that travels before the hold scrolls the list: no drag this time.
      if (held) return finish(null);
      begin();
    }
    e.preventDefault();
    handlers.aim(x, y);
    if (!frame && typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(scroll);
  };
  // Once a finger lifted the element, its moves drag it rather than scroll the page.
  const touchmove = (e: TouchEvent): void => { if (dragging) e.preventDefault(); };
  // The long press that lifted the element opens no menu.
  const contextmenu = (e: Event): void => {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const finish = (drop: { x: number; y: number } | null): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', escape, true);
    window.removeEventListener('touchmove', touchmove);
    window.removeEventListener('contextmenu', contextmenu, true);
    clearTimeout(timer);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    busy = false;
    if (!dragging) return;
    dragging = false;
    root.classList.remove(handlers.rootClass);
    // The click that ends a drag opens nothing; none comes when the pointer left the element.
    const swallow = (e: MouseEvent): void => { e.preventDefault(); e.stopPropagation(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    handlers.end(drop);
  };
  const up = (e: PointerEvent): void => {
    if (e.pointerId === pointer) finish({ x: e.clientX, y: e.clientY });
  };
  const cancel = (e: PointerEvent): void => {
    if (e.pointerId === pointer) finish(null);
  };
  // Escape ends the drag only: elsewhere on the page it stops the turn.
  const escape = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !dragging) return;
    e.preventDefault();
    e.stopPropagation();
    finish(null);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', escape, true);
  if (held) {
    window.addEventListener('touchmove', touchmove, { passive: false });
    window.addEventListener('contextmenu', contextmenu, true);
    timer = setTimeout(begin, handlers.hold);
  }
}
