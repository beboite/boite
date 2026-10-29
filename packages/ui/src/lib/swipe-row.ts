/**
 * A phone's row that a finger slides left to show the actions behind it, as
 * mail and chat apps do. Only a touch drags it: a mouse and a keyboard keep
 * the row's own menu, which offers the same actions. A drag that starts
 * vertical stays the list's scroll. One row is open at a time; a tap on the
 * open row, or anywhere else, closes it.
 */

/** Past this many pixels the gesture has chosen between a slide and a scroll. */
const SLOP = 8;
let opened: (() => void) | null = null;

/**
 * `node` is the row's sliding body; the actions are its sibling marked
 * `data-swipe-actions`, laid under it at the right end.
 */
export function swipeRow(node: HTMLElement) {
  let startX = 0, startY = 0, base = 0, offset = 0;
  let pointer: number | null = null;
  let mode: 'idle' | 'pending' | 'drag' = 'idle';
  let swallow = false;

  const width = () => node.parentElement?.querySelector<HTMLElement>(':scope > [data-swipe-actions]')?.offsetWidth ?? 0;
  function place(x: number, dragging: boolean) {
    offset = x;
    node.classList.toggle('dragging', dragging);
    if (x) node.style.setProperty('--swipe', `${x}px`);
    else node.style.removeProperty('--swipe');
    node.dataset.swiped = x < 0 ? 'true' : 'false';
  }
  function close() {
    place(0, false);
    if (opened === close) opened = null;
    document.removeEventListener('pointerdown', outside, true);
  }
  function open() {
    if (opened && opened !== close) opened();
    place(-width(), false);
    opened = close;
    document.addEventListener('pointerdown', outside, true);
  }
  function outside(event: PointerEvent) {
    if (!node.parentElement?.contains(event.target as Node)) close();
  }

  function down(event: PointerEvent) {
    if (event.pointerType !== 'touch' || pointer !== null) return;
    // A slide the browser ended without a click leaves nothing to swallow for this tap.
    swallow = false;
    pointer = event.pointerId; mode = 'pending';
    startX = event.clientX; startY = event.clientY; base = offset;
  }
  function move(event: PointerEvent) {
    if (event.pointerId !== pointer || mode === 'idle') return;
    const dx = event.clientX - startX, dy = event.clientY - startY;
    if (mode === 'pending') {
      if (Math.abs(dy) > SLOP && Math.abs(dy) >= Math.abs(dx)) { mode = 'idle'; pointer = null; return; }
      if (Math.abs(dx) <= SLOP) return;
      mode = 'drag';
      if (opened && opened !== close) opened();
      try { node.setPointerCapture(event.pointerId); } catch { /* the pointer already left */ }
    }
    event.preventDefault();
    place(Math.max(-width(), Math.min(0, base + dx)), true);
  }
  function up(event: PointerEvent) {
    if (event.pointerId !== pointer) return;
    const dragged = mode === 'drag';
    pointer = null; mode = 'idle';
    if (!dragged) return;
    // The click that ends a slide is not a tap on the row; a cancelled pointer sends no click.
    swallow = event.type === 'pointerup';
    if (event.type !== 'pointercancel' && offset < -width() / 2) open(); else close();
  }
  function click(event: MouseEvent) {
    if (!swallow && offset === 0) return;
    swallow = false;
    event.preventDefault();
    event.stopPropagation();
    if (offset !== 0 && mode === 'idle') close();
  }

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', up);
  node.addEventListener('click', click, true);
  return {
    destroy() {
      if (opened === close) opened = null;
      document.removeEventListener('pointerdown', outside, true);
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
      node.removeEventListener('click', click, true);
    }
  };
}

/** Closes whichever row is open, after one of its actions ran. */
export function closeSwipedRow(): void {
  opened?.();
}
