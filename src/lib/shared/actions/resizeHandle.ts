export interface ResizeHandleOptions {
  onResize: (e: PointerEvent) => void;
  onStateChange?: (resizing: boolean) => void;
}

// Pointer-capture drag for resize handles. Capture keeps the drag alive when
// the cursor leaves the window — the mouse-event versions this replaces got
// stuck mid-drag on button release outside the app.
export function resizeHandle(node: HTMLElement, options: ResizeHandleOptions) {
  let opts = options;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    node.setPointerCapture(e.pointerId);
    opts.onStateChange?.(true);
    const move = (ev: PointerEvent) => opts.onResize(ev);
    const up = (ev: PointerEvent) => {
      if (node.hasPointerCapture(ev.pointerId)) {
        node.releasePointerCapture(ev.pointerId);
      }
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
      opts.onStateChange?.(false);
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
  }

  node.addEventListener("pointerdown", onPointerDown);
  return {
    update(next: ResizeHandleOptions) {
      opts = next;
    },
    destroy() {
      node.removeEventListener("pointerdown", onPointerDown);
    },
  };
}
