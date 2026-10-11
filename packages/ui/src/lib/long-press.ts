/** How long a finger rests on a row before its menu opens, the platform's own long press. */
export const LONG_PRESS_MS = 500;
/** A finger that travels further is scrolling the list, not holding the row. */
const SLOP_PX = 10;

/**
 * A long press opens the row's context menu on a touch screen, the way a right
 * click does with a mouse: the same `contextmenu` handler runs, at the finger.
 * Android may fire its own `contextmenu` for the same press; the first one wins
 * and the timer stops. The click that ends a long press is swallowed, so the
 * row does not also open.
 */
export function longPress(node: HTMLElement): { destroy: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start: { x: number; y: number } | null = null;
  let fired = false;
  let ours = false;

  const cancel = () => { clearTimeout(timer); timer = undefined; start = null; };
  const down = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' || !event.isPrimary) return;
    cancel();
    fired = false;
    start = { x: event.clientX, y: event.clientY };
    const target = event.target instanceof Element ? event.target : node;
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
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > SLOP_PX) cancel();
  };
  // The platform's own long press got there first: it already opened the menu.
  const native = () => { if (!ours && timer !== undefined) { fired = true; cancel(); } };
  const click = (event: MouseEvent) => {
    if (!fired) return;
    fired = false;
    event.preventDefault();
    event.stopPropagation();
  };

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('pointerleave', cancel);
  node.addEventListener('contextmenu', native, true);
  node.addEventListener('click', click, true);
  return {
    destroy() {
      cancel();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', cancel);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('pointerleave', cancel);
      node.removeEventListener('contextmenu', native, true);
      node.removeEventListener('click', click, true);
    }
  };
}
