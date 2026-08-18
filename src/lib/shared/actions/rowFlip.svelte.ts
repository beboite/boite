import { DUR, EASE } from "$lib/theme/motion";

/**
 * Slide a list's rows to their new places instead of teleporting them.
 *
 * FLIP, the ordinary way: the rows' boxes are read before the DOM changes,
 * read again after it, and each row is offered the difference as a transform it
 * animates away. Svelte ships `animate:flip` for exactly this, and it is the
 * better tool wherever it fits — but it has to sit on an element that is the
 * immediate child of a keyed `{#each}`, and the sidebar's rows are drawn by a
 * snippet the two lists share. Rewriting that to satisfy the directive would
 * duplicate the row markup, which is the thing the snippet exists to prevent.
 *
 * So the container is asked instead: hand it the key that changes when the rows
 * change place, and it moves whichever children ended up somewhere else.
 *
 * Rows that arrive and rows that leave are not animated. An entry has no
 * before-box to come from, and a row that left is gone from the DOM by the time
 * anything here runs — the browser's own reflow is the whole of what they do.
 */
export interface RowFlipOptions {
  /**
   * Anything that changes when the rows change place. Read inside the effects,
   * so it must be a live read of reactive state rather than a value captured
   * once: `() => ids.join()`, not `ids.join()`.
   */
  key: () => unknown;
  /**
   * False while something else owns these rows' transforms — a drag, above all,
   * which slides them by hand and would fight anything set here.
   */
  enabled?: () => boolean;
  /** Overrides the layout duration. Keep it in the `DUR` vocabulary. */
  duration?: number;
}

const EASING = `cubic-bezier(${EASE.outQuint.join(", ")})`;

// Under a pixel is a rounding artefact rather than a move, and animating one
// costs a composited layer per row for something nobody can see.
const MIN_MOVE_PX = 1;

function motionReduced(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.motion === "reduced";
}

export function rowFlip(node: HTMLElement, options: RowFlipOptions) {
  let opts = options;
  let before = new Map<Element, DOMRect>();
  // One animation per row at most: a second reorder landing mid-slide replaces
  // the first rather than stacking on it, which is what leaves a row drifting
  // towards a place it no longer belongs to.
  const playing = new Map<Element, Animation>();

  function boxes(): Map<Element, DOMRect> {
    const out = new Map<Element, DOMRect>();
    for (const child of node.children) {
      out.set(child, child.getBoundingClientRect());
    }
    return out;
  }

  // Before the DOM is updated, and with whatever is still sliding left where it
  // is on screen: a row caught mid-move continues from where the eye last saw
  // it rather than jumping back to where it was going.
  $effect.pre(() => {
    opts.key();
    before = boxes();
  });

  $effect(() => {
    opts.key();
    if (opts.enabled?.() === false || motionReduced()) {
      for (const animation of playing.values()) animation.cancel();
      playing.clear();
      before = boxes();
      return;
    }
    // Cancelled before measuring, never after: a running animation is a
    // transform on the row, and reading through one would measure where the row
    // is rather than where it landed.
    for (const animation of playing.values()) animation.cancel();
    playing.clear();
    const after = boxes();
    for (const [child, box] of after) {
      const was = before.get(child);
      if (!was) continue;
      const dx = was.left - box.left;
      const dy = was.top - box.top;
      if (Math.abs(dx) < MIN_MOVE_PX && Math.abs(dy) < MIN_MOVE_PX) continue;
      const animation = child.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: "translate(0px, 0px)" },
        ],
        { duration: opts.duration ?? DUR.slow, easing: EASING },
      );
      playing.set(child, animation);
      animation.finished
        .then(() => {
          if (playing.get(child) === animation) playing.delete(child);
        })
        .catch(() => {
          // A cancelled animation rejects. It was replaced or torn down, and
          // both of those already dropped it from the map.
        });
    }
    before = after;
  });

  return {
    update(next: RowFlipOptions) {
      opts = next;
    },
    destroy() {
      for (const animation of playing.values()) animation.cancel();
      playing.clear();
    },
  };
}
