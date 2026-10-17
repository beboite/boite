/*
 * A tab nobody drives or watches sleeps: its page is frozen, so its timers,
 * animation frames and tasks stop and its renderer costs nothing. It wakes
 * before anything reads or drives it. See docs/browser.md.
 */

/**
 * How long a tab stays awake after the last use, once nothing holds it. An
 * agent's turn holds it, so the wait only covers the gap after the turn ends
 * or the last viewer leaves: a follow-up turn or a viewer coming back within
 * it finds the page as it left it, and an abandoned animation runs at most
 * this long, plus one more wait if a holder was still there at the check.
 */
export const SLEEP_AFTER_MS = 30_000;

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
  timer?: ReturnType<typeof setTimeout>;
  /** Freezing and waking take turns, so a wake asked during a freeze lands after it. */
  turn: Promise<void>;
  dropped: boolean;
}

export function sleepState(): SleepState {
  return { asleep: false, uses: 0, usedAt: Date.now(), turn: Promise.resolve(), dropped: false };
}

const STEP_MS = 5000;

export class TabSleep<T extends Sleeper> {
  /**
   * `held` says whether something keeps the tab awake without a use running:
   * a viewer's screencast, a recording, the agent's turn.
   */
  constructor(private held: (tab: T) => boolean, public afterMs = SLEEP_AFTER_MS) {}

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
   * focus emulation shows it again, so it goes back on after the page is active.
   */
  wake(tab: T): Promise<void> {
    return this.#queue(tab, async () => {
      if (!tab.sleep.asleep) return;
      tab.sleep.asleep = false;
      await tab.page.send('Page.setWebLifecycleState', { state: 'active' }, STEP_MS);
      await tab.page.send('Emulation.setFocusEmulationEnabled', { enabled: true }, STEP_MS);
    });
  }

  /** Checks after `afterMs` whether the tab may sleep, and again later while something holds it. */
  schedule(tab: T): void {
    const state = tab.sleep;
    clearTimeout(state.timer);
    if (state.dropped || state.asleep) return;
    // setTimeout fires at once past 2^31 - 1 ms.
    const left = Math.min(2 ** 31 - 1, Math.max(0, state.usedAt + this.afterMs - Date.now()));
    state.timer = setTimeout(() => {
      if (state.dropped || state.asleep) return;
      if (state.uses > 0 || this.#held(tab)) { state.usedAt = Date.now(); this.schedule(tab); return; }
      if (Date.now() - state.usedAt < this.afterMs) { this.schedule(tab); return; }
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

  /**
   * A focused page is never frozen: focus emulation keeps it shown, and
   * Chromium leaves a shown page running (measured on 2026-10-17).
   * It goes off first. A use that started meanwhile keeps the page awake.
   */
  #sleep(tab: T): Promise<void> {
    return this.#queue(tab, async () => {
      if (tab.sleep.asleep || tab.sleep.dropped || tab.sleep.uses > 0 || this.#held(tab)) return;
      try {
        await tab.page.send('Emulation.setFocusEmulationEnabled', { enabled: false }, STEP_MS);
        await tab.page.send('Page.setWebLifecycleState', { state: 'frozen' }, STEP_MS);
        tab.sleep.asleep = true;
      } catch {
        // A page that cannot freeze stays as it was; one that is gone is dropped by its tab.
        await tab.page.send('Emulation.setFocusEmulationEnabled', { enabled: true }, STEP_MS).catch(() => {});
      }
    });
  }

  #queue(tab: T, run: () => Promise<void>): Promise<void> {
    const next = tab.sleep.turn.then(run);
    tab.sleep.turn = next.catch(() => {});
    return next;
  }
}
