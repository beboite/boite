/** How long a finger rests on a row before its menu opens, the platform's own long press. */
export const LONG_PRESS_MS = 500;
/** A finger that travels further is scrolling the list, not holding the row. */
const SLOP_PX = 10;

/**
 * A long press opens the row's context menu on a touch screen, the way a right
 * click does with a mouse: the same `contextmenu` handler runs, at the finger.
 * Android may fire its own `contextmenu` for the same press; the first one wins
 * and the timer stops. The click that ends a long press is swallowed, so the
 * row does not also open. `accepts` keeps the press to the elements that have
 * a menu, so holding text elsewhere in a block is left to the platform.
 */
export function longPress(node: HTMLElement, accepts?: (target: Element) => boolean): { update: (next?: (target: Element) => boolean) => void; destroy: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The finger holding the row: a second finger neither starts nor ends its press. */
  let pointer: number | null = null;
  let start: { x: number; y: number } | null = null;
  let fired = false;
  let ours = false;

  const cancel = () => { clearTimeout(timer); timer = undefined; start = null; pointer = null; };
  const down = (event: PointerEvent) => {
    // A mouse press ends whatever a touch left behind, so its right click is never taken for that touch's.
    if (event.pointerType === 'mouse') { fired = false; return; }
    if (!event.isPrimary) return;
    cancel();
    fired = false;
    pointer = event.pointerId;
    start = { x: event.clientX, y: event.clientY };
    const target = event.target instanceof Element ? event.target : node;
    if (accepts && !accepts(target)) return;
    timer = setTimeout(() => {
      if (!start) return;
      fired = true;
      ours = true;
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: start.x, clientY: start.y }));
      ours = false;
      cancel();
    }, LONG_PRESS_MS);
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId === pointer && start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > SLOP_PX) cancel();
  };
  const end = (event: PointerEvent) => { if (event.pointerId === pointer) cancel(); };
  // The platform's own long press got there first: it opens the menu and the timer stops. One arriving
  // after ours is the same press: it goes no further, so the menu does not open twice.
  const native = (event: Event) => {
    if (ours) return;
    if (timer !== undefined) { fired = true; cancel(); }
    else if (fired) { event.preventDefault(); event.stopPropagation(); }
  };
  const click = (event: MouseEvent) => {
    if (!fired) return;
    fired = false;
    event.preventDefault();
    event.stopPropagation();
  };

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
  node.addEventListener('pointerleave', end);
  node.addEventListener('contextmenu', native, true);
  node.addEventListener('click', click, true);
  return {
    update(next) { accepts = next; },
    destroy() {
      cancel();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', end);
      node.removeEventListener('pointercancel', end);
      node.removeEventListener('pointerleave', end);
      node.removeEventListener('contextmenu', native, true);
      node.removeEventListener('click', click, true);
    }
  };
}
