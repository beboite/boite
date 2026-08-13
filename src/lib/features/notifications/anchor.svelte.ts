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
   * off, which is the layout the toaster has always had.
   */
  inset = $state(0);

  set(top: number, right: number) {
    const prev = this.box;
    if (prev && prev.top === top && prev.right === right) return;
    this.box = { top, right };
  }

  clear() {
    this.box = null;
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
 * Action for an element that owns the top-right corner before the toasts do.
 *
 * Measures the folded height only: the info box unfolds its log on hover, and
 * a stack that slid down every time the pointer crossed the box would be
 * chasing the mouse. So this goes on the rows that are always drawn, never on
 * the card around them, and the two border pixels of that card are added back.
 */
export function toastInset(el: HTMLElement) {
  const read = () => toastAnchor.setInset(el.getBoundingClientRect().height + 2);
  const observer = new ResizeObserver(read);
  observer.observe(el);
  read();
  return {
    destroy() {
      observer.disconnect();
      toastAnchor.setInset(0);
    },
  };
}
