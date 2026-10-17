import { createSubscriber } from 'svelte/reactivity';

/**
 * The UI's two shared clocks. Reading `now` inside a component, a `$derived`
 * or an `$effect` subscribes that reader; one interval runs while anything
 * reads the clock and the page is on screen, none once the last reader is
 * gone. Read outside a reactive context, `now` is simply the current time.
 * A clock that `rests` also stops while the window is at rest
 * (`<html data-at-rest>`, `lib/at-rest.ts`): sixteen working rows each wrote
 * a new elapsed time every second, one style, layout and paint a second
 * nobody watched.
 */
export interface Clock {
  readonly now: number;
}

function clock(period: number, rests = false): Clock {
  let now = Date.now();
  let running = false;
  const subscribe = createSubscriber((update) => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      now = Date.now();
      update();
    };
    const start = () => {
      if (timer === null) timer = setInterval(tick, period);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const root = document.documentElement;
    const idle = () => document.hidden || (rests && root.hasAttribute('data-at-rest'));
    // A page nobody looks at needs no clock; coming back it catches up at once.
    const wake = () => {
      if (idle()) stop();
      else if (timer === null) {
        tick();
        start();
      }
    };
    running = true;
    now = Date.now();
    document.addEventListener('visibilitychange', wake);
    const rest = rests && typeof MutationObserver !== 'undefined' ? new MutationObserver(wake) : null;
    rest?.observe(root, { attributes: true, attributeFilter: ['data-at-rest'] });
    if (!idle()) start();
    return () => {
      running = false;
      stop();
      document.removeEventListener('visibilitychange', wake);
      rest?.disconnect();
    };
  });
  return {
    get now() {
      subscribe();
      return running ? now : Date.now();
    }
  };
}

/** List times ("3 min ago"): a minute's precision is all they show. */
export const minuteClock = clock(30_000);

/** Live durations of running work; they rest with the window. */
export const secondClock = clock(1_000, true);
