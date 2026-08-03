/**
 * One clock for every relative label on screen.
 *
 * "12 min ago" has to move on its own or it is a lie the moment it is drawn,
 * and the dashboard has three cards' worth of them. A timer per card would be
 * three timers disagreeing about what time it is; this is one, shared, and it
 * stops when nothing is subscribed.
 *
 * It also stops while the window is hidden, which is the rule for anything on a
 * timer that only drives visuals (`rules/performance.md`). Coming back reads the
 * clock at once rather than waiting out the interval, so a window left open
 * overnight is never briefly wrong.
 */
const TICK_MS = 30_000;

class RelativeClock {
  now = $state(Date.now());
  #subscribers = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #visibilityBound = false;

  #bindVisibility() {
    if (this.#visibilityBound || typeof document === "undefined") return;
    this.#visibilityBound = true;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.now = Date.now();
      this.#sync();
    });
  }

  #sync() {
    const wanted =
      this.#subscribers > 0 && (typeof document === "undefined" || !document.hidden);
    if (wanted && this.#timer === null) {
      this.#timer = setInterval(() => {
        this.now = Date.now();
      }, TICK_MS);
    } else if (!wanted && this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** `$effect(() => relativeClock.subscribe())` in a component is the whole
      contract: the effect's cleanup drops the subscription with the component. */
  subscribe(): () => void {
    this.#subscribers++;
    this.#bindVisibility();
    this.now = Date.now();
    this.#sync();
    return () => {
      this.#subscribers = Math.max(0, this.#subscribers - 1);
      this.#sync();
    };
  }
}

export const relativeClock = new RelativeClock();
