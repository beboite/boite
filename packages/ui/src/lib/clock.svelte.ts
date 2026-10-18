import { createSubscriber } from 'svelte/reactivity';

/**
 * The UI's two shared clocks. Reading `now` inside a component, a `$derived`
 * or an `$effect` subscribes that reader; one interval runs while anything
 * reads the clock and the page is on screen, none once the last reader is
 * gone. Read outside a reactive context, `now` is simply the current time.
 */
export interface Clock {
  readonly now: number;
}

function clock(period: number): Clock {
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
    // A hidden page needs no clock; coming back it catches up at once.
    const visibility = () => {
      if (document.hidden) stop();
      else {
        tick();
        start();
      }
    };
    running = true;
    now = Date.now();
    document.addEventListener('visibilitychange', visibility);
    if (!document.hidden) start();
    return () => {
      running = false;
      stop();
      document.removeEventListener('visibilitychange', visibility);
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

/** Live durations of running work. */
export const secondClock = clock(1_000);
