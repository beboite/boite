// One shared interval drives every spinner on screen. N running threads used
// to mean N independent 80ms timers each poking its own $state; here a single
// 40ms base tick (GCD of the 80/200ms spinner cadences) feeds them all and
// stops entirely when the last spinner unmounts.
const BASE_MS = 40;

class SpinnerTicker {
  tick = $state(0);
  #subscribers = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #visibilityBound = false;

  // 25 invalidations a second, each re-rendering every spinner on screen, buys
  // nothing while the window is hidden or minimized — this app sits in the
  // background most of the day. Spinners are phase-derived from a counter, so
  // resuming mid-cycle is invisible.
  #bindVisibility() {
    if (this.#visibilityBound || typeof document === "undefined") return;
    this.#visibilityBound = true;
    document.addEventListener("visibilitychange", () => this.#sync());
  }

  #sync() {
    const wanted =
      this.#subscribers > 0 &&
      (typeof document === "undefined" || !document.hidden);
    if (wanted && this.#timer === null) {
      this.#timer = setInterval(() => {
        this.tick++;
      }, BASE_MS);
    } else if (!wanted && this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  subscribe(): () => void {
    this.#subscribers++;
    this.#bindVisibility();
    this.#sync();
    return () => {
      this.#subscribers = Math.max(0, this.#subscribers - 1);
      this.#sync();
    };
  }
}

export const spinnerTicker = new SpinnerTicker();
export const TICKER_BASE_MS = BASE_MS;
