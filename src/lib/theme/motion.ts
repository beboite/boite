import type { MotionMode } from "$lib/types";

// Applies the animation preference as a data attribute on <html> so CSS gates
// on `html[data-motion="reduced"]` instead of the media query directly — the
// user's explicit choice wins over the OS. Only "system" keeps listening to
// the OS setting. Returns a cleanup for the media-query listener.
export function applyMotionPreference(
  mode: MotionMode,
  doc: Document = document,
): () => void {
  const query =
    doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)") ?? null;
  const apply = () => {
    const reduced =
      mode === "off" || (mode === "system" && (query?.matches ?? false));
    doc.documentElement.dataset.motion = reduced ? "reduced" : "full";
  };
  apply();
  if (mode === "system" && query) {
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }
  return () => {};
}

/**
 * The durations and curves in `app.css`, as numbers Svelte transitions can take.
 *
 * Two copies of the same vocabulary is the point: CSS cannot be handed to
 * `transition:fly` and a Svelte transition cannot read a custom property, so
 * the alternative is every component picking its own 150 or 200 and the app
 * having no answer to "how long does arriving take". These names are the answer.
 * Changing one here means changing it in `app.css` too; the pairing is asserted
 * by `motion.test.ts` so the two cannot drift silently.
 */
export const DUR = {
  /** Hover, colour, anything that must not be perceived as an animation. */
  fast: 90,
  /** The default. Small things entering and leaving: rows, chips, toasts. */
  base: 150,
  /** Layout: a pane, a panel, a column changing width. */
  slow: 220,
  /** A whole page or a deliberate reveal. */
  page: 380,
  /** Something meant to be noticed and read before it goes. */
  celebrate: 620,
} as const;

/** The `cubic-bezier` control points behind `--ease-*`, for `svelte/easing`. */
export const EASE = {
  outQuint: [0.22, 1, 0.36, 1],
  inOutQuad: [0.45, 0, 0.55, 1],
  spring: [0.34, 1.56, 0.64, 1],
} as const;

// Svelte's easing functions take t and return progress; cubicBezier is not in
// svelte/easing, so the curve is evaluated here. Newton would be overkill for
// the precision an animation needs, so this is the usual subdivision: the x
// polynomial is monotonic over [0,1] for every curve above, so bisection on x
// converges, and 12 halvings put the error below a millisecond at 620ms.
function bezier(p: readonly [number, number, number, number]) {
  const [x1, y1, x2, y2] = p;
  const curve = (a: number, b: number, t: number) => {
    const u = 1 - t;
    return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
  };
  return (t: number): number => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let mid = t;
    for (let i = 0; i < 12; i++) {
      mid = (lo + hi) / 2;
      if (curve(x1, x2, mid) < t) lo = mid;
      else hi = mid;
    }
    return curve(y1, y2, mid);
  };
}

export const easeOutQuint = bezier(EASE.outQuint);
export const easeInOutQuad = bezier(EASE.inOutQuad);
/** Overshoots past 1 before settling. Only for the reward moments. */
export const easeSpring = bezier(EASE.spring);
