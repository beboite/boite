/**
 * Holding a finger down, which is what a right-click is on a phone.
 *
 * Every context menu in the app hangs off `oncontextmenu`, and a touch screen
 * has no second button to raise it with. Rather than give the mobile layout its
 * own menus, the same handler gets a second way in.
 *
 * Mouse pointers are ignored: they already have the real thing, and firing on
 * both would open the menu twice for anyone who rests a click.
 */

export type LongPressOptions = {
  /** Called with the viewport point the finger went down on. */
  onLongPress: (x: number, y: number) => void;
  delayMs?: number;
};

// Far enough to be a scroll or a drag rather than a press.
const MOVE_TOLERANCE = 10;

export function longPress(node: HTMLElement, options: LongPressOptions) {
  let opts = options;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startX = 0;
  let startY = 0;
  let fired = false;

  function clear() {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  function down(e: PointerEvent) {
    if (e.pointerType === "mouse") return;
    clear();
    fired = false;
    startX = e.clientX;
    startY = e.clientY;
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      opts.onLongPress(startX, startY);
    }, opts.delayMs ?? 500);
  }

  function move(e: PointerEvent) {
    if (timer === null) return;
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > MOVE_TOLERANCE) clear();
  }

  function cancel() {
    clear();
  }

  // The tap that ends a long press is the same gesture, not a second one: let
  // it through and the menu would open on top of the thing it just launched.
  // Capture, because the element's own click handler runs before a bubbling
  // listener could stop it.
  function swallowClick(e: MouseEvent) {
    if (!fired) return;
    fired = false;
    e.preventDefault();
    e.stopPropagation();
  }

  // Android's WebView raises a real contextmenu on a long press, iOS does not.
  // Whichever gets there first owns the menu: ours drops the native one, the
  // native one cancels our timer. Both would open the same menu twice.
  function swallowContextMenu(e: MouseEvent) {
    if (fired) {
      e.preventDefault();
      return;
    }
    clear();
  }

  node.addEventListener("pointerdown", down);
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", cancel);
  node.addEventListener("pointercancel", cancel);
  node.addEventListener("pointerleave", cancel);
  node.addEventListener("click", swallowClick, true);
  node.addEventListener("contextmenu", swallowContextMenu, true);

  return {
    update(next: LongPressOptions) {
      opts = next;
    },
    destroy() {
      clear();
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", cancel);
      node.removeEventListener("pointercancel", cancel);
      node.removeEventListener("pointerleave", cancel);
      node.removeEventListener("click", swallowClick, true);
      node.removeEventListener("contextmenu", swallowContextMenu, true);
    },
  };
}
