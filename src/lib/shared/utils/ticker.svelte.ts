// One shared interval drives every spinner on screen. N running threads used
// to mean N independent 80ms timers each poking its own $state; here a single
// 40ms base tick (GCD of the 80/200ms spinner cadences) feeds them all and
// stops entirely when the last spinner unmounts.
const BASE_MS = 40;

class SpinnerTicker {
  tick = $state(0);
  #subscribers = 0;
  #timer: ReturnType<typeof setInterval> | null = null;

  subscribe(): () => void {
    this.#subscribers++;
    if (this.#timer === null) {
      this.#timer = setInterval(() => {
        this.tick++;
      }, BASE_MS);
    }
    return () => {
      this.#subscribers--;
      if (this.#subscribers <= 0 && this.#timer !== null) {
        clearInterval(this.#timer);
        this.#timer = null;
        this.#subscribers = 0;
      }
    };
  }
}

export const spinnerTicker = new SpinnerTicker();
export const TICKER_BASE_MS = BASE_MS;
