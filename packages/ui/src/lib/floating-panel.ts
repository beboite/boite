import type { SurfaceRect } from './browser-bridge';

type Options = { enabled: boolean; maximized: boolean };
export const RESIZE_DIRECTIONS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
export type ResizeDirection = typeof RESIZE_DIRECTIONS[number];

/** Keep the panel's chrome and all four edges reachable inside the app. */
export function containPanel(rect: SurfaceRect, bounds: SurfaceRect): SurfaceRect {
  const width = Math.min(bounds.width, Math.max(Math.min(360, bounds.width), rect.width));
  const height = Math.min(bounds.height, Math.max(Math.min(240, bounds.height), rect.height));
  return { width, height,
    x: Math.min(Math.max(rect.x, bounds.x), bounds.x + bounds.width - width),
    y: Math.min(Math.max(rect.y, bounds.y), bounds.y + bounds.height - height) };
}

/** Move only the grabbed edges; the opposite edges stay anchored at every limit. */
export function resizePanel(start: SurfaceRect, dx: number, dy: number, direction: ResizeDirection, bounds: SurfaceRect): SurfaceRect {
  const minimumWidth = Math.min(360, bounds.width), minimumHeight = Math.min(240, bounds.height);
  let left = start.x, top = start.y, right = start.x + start.width, bottom = start.y + start.height;
  if (direction.includes('w')) left = Math.max(bounds.x, Math.min(right - minimumWidth, left + dx));
  if (direction.includes('e')) right = Math.min(bounds.x + bounds.width, Math.max(left + minimumWidth, right + dx));
  if (direction.includes('n')) top = Math.max(bounds.y, Math.min(bottom - minimumHeight, top + dy));
  if (direction.includes('s')) bottom = Math.min(bounds.y + bounds.height, Math.max(top + minimumHeight, bottom + dy));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** One DOM panel and one webview throughout move, resize, maximize and dock. */
export function floatingPanel(node: HTMLElement, initial: Options) {
  let options = initial;
  let rect: SurfaceRect | null = null;
  let drag: { pointer: number; handle: Element; x: number; y: number; start: SurfaceRect; direction?: ResizeDirection; moved: boolean } | null = null;
  let suppressClick = false;
  const win = node.ownerDocument.defaultView!;
  function bounds(): SurfaceRect {
    const parent = node.parentElement!.getBoundingClientRect();
    const inset = win.innerWidth <= 720 ? 0 : 8;
    return { x: parent.x + inset, y: parent.y + inset, width: Math.max(1, parent.width - inset * 2), height: Math.max(1, parent.height - inset * 2) };
  }
  function paint() {
    if (!options.enabled) return;
    const room = bounds();
    rect = containPanel(rect ?? { x: room.x + room.width * .22, y: room.y + 24, width: room.width * .74, height: room.height * .84 }, room);
    const shown = options.maximized || win.innerWidth <= 720 ? room : rect;
    for (const key of ['x', 'y', 'width', 'height'] as const) node.style.setProperty(`--float-${key}`, `${shown[key]}px`);
  }
  function end() {
    suppressClick = drag?.moved ?? false;
    if (drag?.handle.hasPointerCapture?.(drag.pointer)) drag.handle.releasePointerCapture(drag.pointer);
    drag = null;
  }
  function down(event: PointerEvent) {
    suppressClick = false;
    if (!options.enabled || options.maximized || win.innerWidth <= 720 || event.button !== 0 || !(event.target instanceof Element)) return;
    const handle = event.target.closest<HTMLElement>('[data-panel-move],[data-panel-resize]');
    if (!handle || !node.contains(handle) || !rect) return;
    // The whole title bar moves, including tab labels, but its controls and
    // top-layer menus keep their normal pointer/keyboard behavior.
    const control = event.target.closest('button,a,input,textarea,select,[role="button"],[role="menu"],[contenteditable="true"]');
    if (control && control !== handle) return;
    const direction = handle.dataset.panelResize as ResizeDirection | undefined;
    if (direction) { event.preventDefault(); handle.focus({ preventScroll: true }); }
    // Capture the original target so clicks still reach the tab, and crossing
    // the child webview during a drag cannot steal the remaining pointer events.
    event.target.setPointerCapture(event.pointerId);
    drag = { pointer: event.pointerId, handle: event.target, x: event.clientX, y: event.clientY, start: { ...rect }, direction, moved: false };
  }
  function move(event: PointerEvent) {
    if (!drag || drag.pointer !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    drag.handle.setPointerCapture(event.pointerId);
    event.preventDefault();
    rect = drag.direction ? resizePanel(drag.start, dx, dy, drag.direction, bounds())
      : { ...drag.start, x: drag.start.x + dx, y: drag.start.y + dy };
    paint();
  }
  function click(event: MouseEvent) {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false;
    event.preventDefault(); event.stopPropagation();
  }
  function key(event: KeyboardEvent) {
    if (!options.enabled || options.maximized || !rect || !(event.target instanceof HTMLElement)) return;
    if (!event.target.matches('[data-panel-move],[data-panel-resize]')) return;
    const dx = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0;
    const dy = event.key === 'ArrowUp' ? -16 : event.key === 'ArrowDown' ? 16 : 0;
    if (!dx && !dy) return;
    event.preventDefault(); event.stopPropagation();
    const direction = event.target.dataset.panelResize as ResizeDirection | undefined;
    rect = direction ? resizePanel(rect, dx, dy, direction, bounds())
      : { ...rect, x: rect.x + dx, y: rect.y + dy };
    paint();
  }
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(paint) : null;
  observer?.observe(node.parentElement!);
  win.addEventListener('resize', paint);
  node.addEventListener('pointerdown', down);
  win.addEventListener('pointermove', move);
  win.addEventListener('pointerup', end);
  win.addEventListener('pointercancel', end);
  node.addEventListener('click', click, true);
  node.addEventListener('keydown', key);
  paint();
  return {
    update(next: Options) { end(); options = next; paint(); },
    destroy() {
      end(); observer?.disconnect(); win.removeEventListener('resize', paint);
      node.removeEventListener('pointerdown', down); win.removeEventListener('pointermove', move);
      win.removeEventListener('pointerup', end); win.removeEventListener('pointercancel', end); node.removeEventListener('keydown', key);
      node.removeEventListener('click', click, true);
    }
  };
}
