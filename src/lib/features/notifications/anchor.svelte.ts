/**
 * The box toasts are allowed to sit in: the work area, not the window.
 *
 * A toast is news about what an agent just did, so it belongs over the agent.
 * Fixed to the window it landed on whatever the user had opened beside the
 * terminal instead — the docked git, files or todo column — and covered the
 * commit button of a panel the toast had nothing to say about.
 *
 * Client coordinates, because the toaster is `position: fixed`: `right` is the
 * gap from the right edge of the window, which is what CSS wants.
 */
class ToastAnchor {
  box = $state<{ top: number; right: number } | null>(null);

  /**
   * Height already taken in that corner by something the toasts must not cover,
   * the info box experiment being the only claimant today. Zero whenever it is
   * off, which is the layout the toaster has always had. Resolved from the
   * claims below rather than written by whoever moved last.
   */
  inset = $state(0);

  set(top: number, right: number) {
    const prev = this.box;
    if (prev && prev.top === top && prev.right === right) return;
    this.box = { top, right };
    // The corner moved, so which box is standing in it is a different answer
    // now, and a box that only moved never fired its own ResizeObserver.
    remeasureCorner();
  }

  clear() {
    this.box = null;
    remeasureCorner();
  }

  setInset(px: number) {
    if (this.inset === px) return;
    this.inset = px;
  }
}

export const toastAnchor = new ToastAnchor();

/**
 * Action for the element toasts should stay inside, the main work column.
 *
 * On `<main>` rather than the pane viewport: the viewport is `display: none`
 * while the editor, the project page or the settings are up, so it measures
 * zero and its last known position goes stale the first time the sidebar is
 * toggled from one of those views. `<main>` is the same area and is always
 * drawn.
 *
 * A ResizeObserver is enough for the moves that matter here: the sidebar, the
 * docked panel and the window itself all change this element's width when they
 * change its position. Cleared on destroy so the login and setup screens, which
 * never render `<main>`, fall back to the window corner.
 */
export function toastArea(el: HTMLElement) {
  const read = () => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    toastAnchor.set(r.top, Math.max(0, window.innerWidth - r.right));
  };
  const observer = new ResizeObserver(read);
  observer.observe(el);
  read();
  return {
    destroy() {
      observer.disconnect();
      toastAnchor.clear();
    },
  };
}

/**
 * Who is standing in the toast corner, one entry per box rather than one
 * number for the window.
 *
 * The info box used to be a single mount over the whole pane area, so a scalar
 * was the whole story. It is one box per terminal now, which means one per
 * thread in every group: the groups nobody is looking at stay mounted and are
 * hidden with `visibility`, and a hidden-but-laid-out element still has a real
 * height and still fires its ResizeObserver. A shared scalar therefore let the
 * last box to resize anywhere in the window, offscreen group included, set the
 * inset for a corner it does not stand in, and let the first box to unmount
 * zero an inset the boxes still on screen were relying on.
 *
 * Each box owns exactly one key and can only ever write or drop its own, the
 * same claim-and-release shape the info box uses to elect one git poller per
 * repository. What is resolved out of it is the tallest claim among the boxes
 * that say they are on screen: the corner has the same coordinates in every
 * group, so a box nobody is looking at measures a real height in it, and the
 * tallest of those pushed the stack a visible row or two below the box it is
 * meant to sit under.
 */
const corner = new Map<symbol, { el: HTMLElement; px: number; standing: boolean }>();

/**
 * How close to the anchor's corner a box has to be to count as standing in it.
 *
 * The toaster and the box are laid out from the same 0.75rem gutter, so a box
 * in the corner sits exactly one gutter inside it; the UI scale slider is a
 * root font size, which moves that gutter, hence the room. Nothing else comes
 * anywhere near: the closest box that is not in the corner belongs to another
 * pane of a split, half a viewport away.
 */
const CORNER_REACH = 32;

/** How much room `el` takes out of the corner, zero if it is not in it. */
function measureCorner(el: HTMLElement): number {
  const anchor = toastAnchor.box;
  if (!anchor) return 0;
  const rect = el.getBoundingClientRect();
  // A box under `display: none`, which is every pane while a view is drawn
  // over the terminals, measures zero. Zero is the right answer there: nothing
  // is standing in the corner, so the stack takes it back.
  if (rect.width <= 0 || rect.height <= 0) return 0;
  const fromTop = rect.top - anchor.top;
  const fromRight = window.innerWidth - anchor.right - rect.right;
  if (Math.abs(fromTop) > CORNER_REACH || Math.abs(fromRight) > CORNER_REACH) {
    return 0;
  }
  return rect.height;
}

function resolveInset() {
  let px = 0;
  for (const claim of corner.values()) px = Math.max(px, claim.px);
  toastAnchor.setInset(px);
}

/**
 * Ask every claim again.
 *
 * Run from any one box's observer rather than only re-reading that box: a pane
 * closing or a divider moving repositions boxes whose own size never changed,
 * and a ResizeObserver has nothing to say about an element that only moved.
 */
function remeasureCorner() {
  for (const claim of corner.values()) {
    claim.px = claim.standing ? measureCorner(claim.el) : 0;
  }
  resolveInset();
}

/**
 * Action for a box that stands in the top-right corner before the toasts do.
 *
 * Measures the whole card, unfolded log included. Measuring the folded rows
 * alone kept the stack off the collapsed box and nothing else: the log unfolds
 * into exactly the room the stack was pushed into, at z-5 and so under the
 * toasts, and two cards up plus a pointer on the box hid rows two to ten
 * behind opaque toasts. The stack sliding down as the box unfolds is not it
 * chasing the pointer, it is getting out of the way of what the pointer asked
 * to read.
 *
 * The corner is claimed, not assumed: split view mounts one of these over
 * every terminal and the toasts only ever land on the box that owns it.
 *
 * `standing` is the caller's own answer about whether its box is on screen, and
 * it is what the geometry cannot give: a pane in another group keeps its box
 * mounted, hidden with `visibility` and laid out at the same coordinates as the
 * one being looked at, so it measures a real height in the same corner. The
 * tallest of those decided the inset, and the stack sat that far below a
 * visible box that is shorter — the gap between the two.
 */
export function toastInset(el: HTMLElement, standing: boolean = true) {
  const token = Symbol("toast-inset");
  corner.set(token, { el, px: 0, standing });
  const observer = new ResizeObserver(remeasureCorner);
  observer.observe(el);
  remeasureCorner();
  return {
    update(next: boolean) {
      const claim = corner.get(token);
      if (!claim || claim.standing === next) return;
      claim.standing = next;
      remeasureCorner();
    },
    destroy() {
      observer.disconnect();
      // Its own claim and no more. The other boxes are still on screen, and a
      // ResizeObserver does not fire again on a box whose size did not change,
      // so an inset zeroed from here would never be restored: the stack would
      // sit back on top of a box that is still drawn, for good.
      corner.delete(token);
      resolveInset();
    },
  };
}
