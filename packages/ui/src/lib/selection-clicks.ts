/** A text-selection drag can finish with a click on a link or button. Keep the native selection, skip its activation. */
export function selectionClicks(node: HTMLElement): { destroy(): void } {
  let start: { x: number; y: number; id: number } | undefined;
  let dragged = false;
  const move = (event: PointerEvent) => {
    if (start && event.pointerId === start.id && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) dragged = true;
  };
  const release = () => {
    start = undefined;
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('blur', cancel);
  };
  const end = (event: PointerEvent) => { move(event); release(); };
  const cancel = () => { dragged = true; release(); };
  const press = (event: PointerEvent) => {
    release();
    dragged = false;
    if (event.button !== 0) return;
    start = { x: event.clientX, y: event.clientY, id: event.pointerId };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', cancel);
  };
  const click = (event: MouseEvent) => {
    // Keyboard and assistive activation carry no pointer gesture.
    if (!dragged || event.detail === 0) return;
    dragged = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  node.addEventListener('pointerdown', press, true);
  node.addEventListener('click', click, true);
  return { destroy() { release(); node.removeEventListener('pointerdown', press, true); node.removeEventListener('click', click, true); } };
}
