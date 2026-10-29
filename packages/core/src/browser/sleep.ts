/*
 * A tab nobody drives or watches sleeps: its page is frozen, so its timers,
 * animation frames and tasks stop and its renderer costs nothing. It wakes
 * before anything reads or drives it. See docs/browser.md.
 */

/**
 * How long a tab stays awake after the last use, once nothing holds it: a
 * follow-up turn or a viewer coming back within it finds the page as it left
 * it, and an abandoned animation runs at most this long, plus one more wait
 * if a holder was still there at the check.
 */
export const SLEEP_AFTER_MS = 30_000;
/**
 * How long the agent's running turn keeps a tab awake after its last use: a
 * turn that works elsewhere for half an hour leaves the tab asleep, and its
 * next command wakes it.
 */
export const TURN_HOLD_MS = 5 * 60_000;

/** What the sleep of one tab needs of it: its page's DevTools session. */
export interface Sleeper {
  page: { send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> };
  sleep: SleepState;
}

export interface SleepState {
  asleep: boolean;
  /** Uses running now: a command, a viewer's frame or input. */
  uses: number;
  usedAt: number;
  /** When a holder was last seen: the wait for sleep runs from the later of this and `usedAt`. */
  heldAt: number;
  timer?: ReturnType<typeof setTimeout>;
  /**
   * Brought to the front as it wakes. A page of the core's own browser that is
   * not its front tab is drawn only while focus emulation keeps it shown, and
   * the freeze hides it: woken, it stays hidden and a capture waits for a frame
   * that never comes. The desktop app's webviews are not raised: that could
   * show the user's window.
   */
  front: boolean;
  /** Freezing and waking take turns, so a wake asked during a freeze lands after it. */
  turn: Promise<void>;
  dropped: boolean;
}

export function sleepState(front = false): SleepState {
  return { asleep: false, uses: 0, usedAt: Date.now(), heldAt: 0, front, turn: Promise.resolve(), dropped: false };
}

const STEP_MS = 5000;
/** How long a step that missed its time is still listened to, so the log says whether its answer came late or not at all. */
const LATE_MS = 30_000;
/** What the browser gets to answer for itself once a step missed its time. */
const PROBE_MS = 1000;

export class TabSleep<T extends Sleeper> {
  /** What each DevTools call of a freeze or a wake may take; tests shorten it. */
  stepMs = STEP_MS;
  /**
   * Asked of the browser itself, within `timeoutMs`, when a step of a tab
   * misses its time: an answer puts the stall in that page's renderer, none
   * in the browser or its connection.
   */
  browserAnswers: (tab: T, timeoutMs: number) => Promise<unknown> = () => Promise.resolve();
  /** Hears, once the step has failed, how long the browser took to answer for itself, or null for no answer in time. */
  browserAnswered: (tab: T, method: string, ms: number | null) => void = () => {};
  /** Hears when a step that missed its time got its answer, in ms after it was sent, or why none came. */
  lateAnswer: (tab: T, method: string, after: number | Error) => void = () => {};

  /**
   * `held` says whether something keeps the tab awake without a use running:
   * a viewer, a recording. `turning` says whether its agent's turn runs, which
   * keeps it awake only `turnMs` after its last use.
   */
  constructor(private held: (tab: T) => boolean, private turning: (tab: T) => boolean = () => false, public afterMs = SLEEP_AFTER_MS, public turnMs = TURN_HOLD_MS) {}

  /** Runs `run` on an awake page, and starts the wait for sleep again once it ends. */
  async use<R>(tab: T, run: () => Promise<R>): Promise<R> {
    tab.sleep.uses++;
    try {
      await this.wake(tab);
      return await run();
    } finally {
      tab.sleep.uses--;
      tab.sleep.usedAt = Date.now();
      this.schedule(tab);
    }
  }

  /**
   * The page as it was before it slept. Frozen, a page is also hidden, and
   * focus emulation shows it again, so it goes back on after the page is active;
   * a page that must be raised to draw again is raised last (`front`).
   * A wake that fails leaves the tab asleep, so the next use tries it again.
   */
  wake(tab: T): Promise<void> {
    return this.#queue(tab, async () => {
      if (!tab.sleep.asleep) return;
      await this.#step(tab, 'Page.setWebLifecycleState', { state: 'active' });
      await this.#step(tab, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      if (tab.sleep.front) await this.#step(tab, 'Page.bringToFront', {});
      tab.sleep.asleep = false;
    });
  }

  /** Checks after `afterMs` whether the tab may sleep, and again later while something holds it. */
  schedule(tab: T): void {
    const state = tab.sleep;
    clearTimeout(state.timer);
    if (state.dropped || state.asleep) return;
    // setTimeout fires at once past 2^31 - 1 ms.
    const left = Math.min(2 ** 31 - 1, Math.max(0, Math.max(state.usedAt, state.heldAt) + this.afterMs - Date.now()));
    state.timer = setTimeout(() => {
      if (state.dropped || state.asleep) return;
      // The turn holds from the last use, not from the last check, so a turn that leaves the tab alone lets it sleep.
      if (state.uses > 0 || this.#held(tab) || this.#turnHolds(tab)) { state.heldAt = Date.now(); this.schedule(tab); return; }
      if (Date.now() - Math.max(state.usedAt, state.heldAt) < this.afterMs) { this.schedule(tab); return; }
      void this.#sleep(tab);
    }, left);
    (state.timer as { unref?: () => void }).unref?.();
  }

  drop(tab: T): void {
    tab.sleep.dropped = true;
    clearTimeout(tab.sleep.timer);
  }

  #held(tab: T): boolean {
    try { return this.held(tab); } catch { return true; }
  }

  #turnHolds(tab: T): boolean {
    let turning: boolean;
    try { turning = this.turning(tab); } catch { turning = true; }
    return turning && Date.now() - tab.sleep.usedAt < this.turnMs;
  }

  /**
   * A focused page is never frozen: focus emulation keeps it shown, and
   * Chromium leaves a shown page running (measured on 2026-10-17).
   * It goes off first. A use that started meanwhile keeps the page awake.
   */
  #sleep(tab: T): Promise<void> {
    return this.#queue(tab, async () => {
      if (tab.sleep.asleep || tab.sleep.dropped || tab.sleep.uses > 0 || this.#held(tab) || this.#turnHolds(tab)) return;
      try {
        await this.#step(tab, 'Emulation.setFocusEmulationEnabled', { enabled: false });
        await this.#step(tab, 'Page.setWebLifecycleState', { state: 'frozen' });
        tab.sleep.asleep = true;
      } catch {
        // A page that cannot freeze stays as it was and tries again after the wait; one that is gone is dropped by its tab.
        await this.#step(tab, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
        tab.sleep.heldAt = Date.now();
        this.schedule(tab);
      }
    });
  }

  /**
   * One DevTools call of a freeze or a wake, given `stepMs`. A frozen page
   * answers at once (measured on 2026-10-19), so a call that misses its time
   * met a stalled renderer or browser. The step fails at its time; whether
   * the browser itself still answers, and when the page does, reach the log after.
   */
  async #step(tab: T, method: string, params: Record<string, unknown>): Promise<void> {
    const sent = performance.now();
    const answer = tab.page.send(method, params, LATE_MS);
    if (await within(answer.then(() => true), this.stepMs) !== null) return;
    void answer.then(() => this.lateAnswer(tab, method, Math.round(performance.now() - sent)), (error: Error) => this.lateAnswer(tab, method, error));
    const probeMs = Math.min(PROBE_MS, this.stepMs), probed = performance.now();
    void within(Promise.resolve(this.browserAnswers(tab, probeMs)).then(() => true, () => null), probeMs)
      .then(answered => this.browserAnswered(tab, method, answered === null ? null : Math.round(performance.now() - probed)));
    throw new Error(`the browser did not answer ${method} within ${this.stepMs / 1000} seconds`);
  }

  #queue(tab: T, run: () => Promise<void>): Promise<void> {
    const next = tab.sleep.turn.then(run);
    tab.sleep.turn = next.catch(() => {});
    return next;
  }
}

/** What `promise` gives within `ms`, or null; its rejection passes through. */
async function within<R>(promise: Promise<R>, ms: number): Promise<R | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); })]);
  } finally { clearTimeout(timer); }
}
