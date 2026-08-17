/**
 * The box toasts are allowed to sit in: the work area, not the window.
 *
 * A toast is news about what an agent just did, so it belongs over the agent.
 * Fixed to the window it landed on whatever the user had opened beside the
 * terminal instead, the docked git, files or todo column, and covered the
 * commit button of a panel the toast had nothing to say about.
 *
 * Client coordinates, because the toaster is `position: fixed`: `right` is the
 * gap from the right edge of the window, which is what CSS wants.
 */

export type ToastStack = "above" | "below";
export type ToastAlign = "left" | "center" | "right";

export type ToastClaim = {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  stack: ToastStack;
  align: ToastAlign;
};

class ToastAnchor {
  box = $state<{ top: number; right: number } | null>(null);

  /**
   * The standing info box the stack attaches to, or null when none is on
   * screen. The toaster sits below it, or above it when the box is on a
   * bottom edge.
   */
  claim = $state<ToastClaim | null>(null);

  /**
   * Height of that box. Kept so existing readers keep working: it is just
   * `claim.height`, zero when there is no claim.
   */
  get inset(): number {
    return this.claim?.height ?? 0;
  }

  set(top: number, right: number) {
    const prev = this.box;
    if (prev && prev.top === top && prev.right === right) return;
    this.box = { top, right };
    // The work area moved, so which box is standing in it is a different
    // answer now, and a box that only moved never fired its own ResizeObserver.
    remeasureToastClaims();
  }

  clear() {
    this.box = null;
    remeasureToastClaims();
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

export type ToastInsetParams = {
  standing: boolean;
  focused?: boolean;
  stack: ToastStack;
  align: ToastAlign;
};

/**
 * Who the toast stack attaches to, one entry per box rather than one number
 * for the window.
 *
 * The info box is one mount per terminal, which means one per thread in every
 * group: the groups nobody is looking at stay mounted and are hidden with
 * `visibility`, and a hidden-but-laid-out element still has a real height and
 * still fires its ResizeObserver. Each box owns exactly one key and can only
 * ever write or drop its own.
 *
 * What is resolved out of it is the focused standing box, or the tallest
 * standing one when none is focused. A box whose group is off screen never
 * wins, even if it is taller: it would push the stack off a shorter box the
 * user can actually see.
 */
const claims = new Map<
  symbol,
  { el: HTMLElement; standing: boolean; focused: boolean; stack: ToastStack; align: ToastAlign }
>();

function readRect(el: HTMLElement): ToastClaim | null {
  const rect = el.getBoundingClientRect();
  // A box under `display: none`, which is every pane while a view is drawn
  // over the terminals, measures zero. Zero is the right answer there.
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    top: rect.top,
    left: rect.left,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
    stack: "below",
    align: "right",
  };
}

function resolveClaim() {
  let best: (ToastClaim & { focused: boolean }) | null = null;
  for (const claim of claims.values()) {
    if (!claim.standing) continue;
    const rect = readRect(claim.el);
    if (!rect) continue;
    const candidate = {
      ...rect,
      stack: claim.stack,
      align: claim.align,
      focused: claim.focused,
    };
    if (!best) {
      best = candidate;
      continue;
    }
    if (candidate.focused && !best.focused) {
      best = candidate;
      continue;
    }
    if (candidate.focused === best.focused && candidate.height > best.height) {
      best = candidate;
    }
  }
  const next = best
    ? {
        top: best.top,
        left: best.left,
        right: best.right,
        bottom: best.bottom,
        width: best.width,
        height: best.height,
        stack: best.stack,
        align: best.align,
      }
    : null;
  const prev = toastAnchor.claim;
  if (
    prev &&
    next &&
    prev.top === next.top &&
    prev.left === next.left &&
    prev.right === next.right &&
    prev.bottom === next.bottom &&
    prev.width === next.width &&
    prev.height === next.height &&
    prev.stack === next.stack &&
    prev.align === next.align
  ) {
    return;
  }
  toastAnchor.claim = next;
}

/** Ask every claim again. A drag moves a box without resizing it. */
export function remeasureToastClaims() {
  resolveClaim();
}

/**
 * Action for a box the toasts must not cover.
 *
 * Measures the whole card, unfolded log included. The stack sits below it, or
 * above it when the box is docked on a bottom edge.
 *
 * `standing` is the caller's own answer about whether its box is on screen, and
 * it is what the geometry cannot give: a pane in another group keeps its box
 * mounted, hidden with `visibility` and laid out at the same coordinates as the
 * one being looked at.
 */
export function toastInset(el: HTMLElement, params: ToastInsetParams) {
  const token = Symbol("toast-inset");
  claims.set(token, {
    el,
    standing: params.standing,
    focused: params.focused ?? false,
    stack: params.stack,
    align: params.align,
  });
  const observer = new ResizeObserver(remeasureToastClaims);
  observer.observe(el);
  remeasureToastClaims();
  return {
    update(next: ToastInsetParams) {
      const claim = claims.get(token);
      if (!claim) return;
      claim.standing = next.standing;
      claim.focused = next.focused ?? false;
      claim.stack = next.stack;
      claim.align = next.align;
      remeasureToastClaims();
    },
    destroy() {
      observer.disconnect();
      claims.delete(token);
      resolveClaim();
    },
  };
}
