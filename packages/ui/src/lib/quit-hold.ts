/*
 * The quit hold: `Ctrl+Q` quits the shell only when it is held for a while or
 * pressed twice in a row, T3 Code's "hold" confirmation. A key that is
 * hit once by accident does nothing but show the hint; the tray's Quit
 * stays immediate, since a menu item is never a slip of the finger.
 *
 * Pure timing over injected clocks, so the whole rule is a unit test. The
 * hold runs on a timer rather than on key repeat: repeat rates are the OS's
 * and a slow one would never reach the threshold.
 */

export const QUIT_HOLD_MS = 1200;
export const QUIT_DOUBLE_MS = 500;

export interface QuitHoldOptions {
  holdMs?: number;
  doubleMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Called once when the rule is satisfied. */
  onQuit: () => void;
  /** Called when the hint should show or hide. */
  onHolding?: (holding: boolean) => void;
}

export class QuitHold {
  readonly holdMs: number;
  readonly doubleMs: number;
  #now: () => number;
  #setTimer: (fn: () => void, ms: number) => unknown;
  #clearTimer: (handle: unknown) => void;
  #onQuit: () => void;
  #onHolding: (holding: boolean) => void;
  #timer: unknown = null;
  #holding = false;
  #lastRelease = Number.NEGATIVE_INFINITY;
  #done = false;

  constructor(options: QuitHoldOptions) {
    this.holdMs = options.holdMs ?? QUIT_HOLD_MS;
    this.doubleMs = options.doubleMs ?? QUIT_DOUBLE_MS;
    this.#now = options.now ?? (() => performance.now());
    this.#setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#onQuit = options.onQuit;
    this.#onHolding = options.onHolding ?? (() => {});
  }

  get holding(): boolean {
    return this.#holding;
  }

  /** `Ctrl+Q` went down. Key repeat calls this again and is ignored while holding. */
  press(): void {
    if (this.#done || this.#holding) return;
    const now = this.#now();
    if (now - this.#lastRelease <= this.doubleMs) {
      this.#quit();
      return;
    }
    this.#holding = true;
    this.#onHolding(true);
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      if (this.#holding) this.#quit();
    }, this.holdMs);
  }

  /** The key, or the window's focus, went away before the hold was done. */
  release(): void {
    if (!this.#holding) return;
    this.#lastRelease = this.#now();
    this.#stop();
  }

  /** Nothing fires after this, whatever the keys do. */
  dispose(): void {
    this.#stop();
    this.#done = true;
  }

  #stop(): void {
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    if (this.#holding) {
      this.#holding = false;
      this.#onHolding(false);
    }
  }

  #quit(): void {
    this.#stop();
    this.#done = true;
    this.#onQuit();
  }
}

/** True for the quit chord on either platform: `Ctrl+Q` and `Cmd+Q`. */
export function isQuitChord(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'q';
}
