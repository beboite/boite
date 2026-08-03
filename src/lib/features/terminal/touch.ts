/**
 * Two fingers on a terminal: pinch to size the font, drag to scroll.
 *
 * A class rather than four handlers in the component, because the interesting
 * part is the state between them — which gesture is running, where the last
 * finger was, and how much of a row is left over. That state was five loose
 * variables in a 1 592-line file, and the arithmetic in the middle of it is the
 * only part anyone ever gets wrong.
 *
 * Nothing here touches the DOM. The caller decides what a scroll and a zoom
 * mean; this decides how far.
 */

/** What the terminal has to do about a move, if anything. */
export type Gesture =
  | { kind: "none" }
  /** Scroll by this many lines. Positive is towards older output. */
  | { kind: "scroll"; lines: number }
  /** The pinch multiplier, before the caller clamps it to its font range. */
  | { kind: "zoom"; factor: number };

const NOTHING: Gesture = { kind: "none" };

/** Enough of a `TouchList` to measure. */
type Points = ArrayLike<{ clientX: number; clientY: number }>;

function distance(t: Points): number {
  return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
}

export class Touches {
  #mode: "none" | "scroll" | "pinch" = "none";
  #pinchStartDist = 0;
  #pinchStartFactor = 1;
  #lastY = 0;
  /** Movement that has not added up to a whole row yet. Kept, never dropped. */
  #accumulated = 0;

  /** The gesture in flight, for a caller that wants to preventDefault. */
  get mode() {
    return this.#mode;
  }

  start(touches: Points, factor: number) {
    if (touches.length >= 2) {
      this.#mode = "pinch";
      this.#pinchStartDist = distance(touches);
      this.#pinchStartFactor = factor;
      return;
    }
    this.#mode = "scroll";
    this.#lastY = touches[0].clientY;
    this.#accumulated = 0;
  }

  /**
   * What this move means.
   *
   * `rowPx` is how tall a line is, so the leftover can be kept across moves:
   * throwing away the remainder is what makes a slow drag scroll nothing at
   * all, and rounding it up is what makes it scroll twice as far as the finger.
   */
  move(touches: Points, rowPx: number): Gesture {
    if (this.#mode === "pinch" && touches.length >= 2) {
      if (this.#pinchStartDist <= 0) return NOTHING;
      const ratio = distance(touches) / this.#pinchStartDist;
      return { kind: "zoom", factor: this.#pinchStartFactor * ratio };
    }
    if (this.#mode === "scroll" && touches.length === 1) {
      const y = touches[0].clientY;
      this.#accumulated += y - this.#lastY;
      this.#lastY = y;
      const lines = Math.trunc(this.#accumulated / rowPx);
      if (lines === 0) return NOTHING;
      this.#accumulated -= lines * rowPx;
      // Content follows the finger: dragging up reveals newer output, which is
      // the opposite sign from where the finger went.
      return { kind: "scroll", lines: -lines };
    }
    return NOTHING;
  }

  /**
   * A finger left.
   *
   * Releasing one of two hands back to a scroll rather than ending the gesture:
   * the remaining finger is still on the screen, and treating it as a fresh
   * touch is what makes the terminal jump when a pinch ends unevenly.
   */
  end(touches: Points) {
    if (touches.length === 0) {
      this.#mode = "none";
      return;
    }
    if (touches.length === 1) {
      this.#mode = "scroll";
      this.#lastY = touches[0].clientY;
      this.#accumulated = 0;
    }
  }
}
