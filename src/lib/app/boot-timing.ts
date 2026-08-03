import { logger } from "$lib/shared/services/logger.svelte";

/**
 * How long the window took to become usable, phase by phase.
 *
 * The reason this exists is a standing rule: an optimisation with no
 * measurement attached is removed. `init()` carries three that nobody could put
 * a number on — the row load fired before `settings.init()` so boot is two round
 * trips deep instead of three, the shell probe kicked off in the background, and
 * the terminal view prefetched while idle. Each is a comment claiming a saving.
 * A comment is not a measurement.
 *
 * One log line, not one per phase. Frontend `info` lines are deliberately kept
 * off the timeline because they are written on the way through working code
 * several times a second, and a phase-per-line trace of every boot is exactly
 * the noise that rule exists to prevent.
 *
 * A boot slower than {@link SLOW_BOOT_MS} is written at `warn` instead, which
 * puts it on the timeline next to whatever else was happening — a worktree
 * migration, a remote that would not answer, a command that refused. That is
 * the case somebody is actually trying to explain, and it needs no new
 * mechanism to be visible.
 */
export const SLOW_BOOT_MS = 2_000;

/** A phase name and when it finished, relative to the first mark. */
interface Phase {
  name: string;
  atMs: number;
}

/**
 * `performance.now()` where it exists, wall clock where it does not.
 *
 * A monotonic clock is what this wants: the numbers are differences, and a
 * system clock that steps during boot would produce a negative phase. vitest's
 * jsdom has `performance`, and so does every runtime Boite ships in, but a
 * timing helper that throws is worse than one that is slightly less precise.
 */
function now(): number {
  return typeof performance?.now === "function" ? performance.now() : Date.now();
}

export class BootTiming {
  #startedAt: number | null = null;
  #phases: Phase[] = [];
  #reported = false;

  /** Starts the clock. A second call is ignored, so a re-entered boot does not
   *  reset the measurement half way through. */
  start() {
    this.#startedAt ??= now();
  }

  /** Records that a phase just finished. Silent before {@link start}, because a
   *  mark with no clock behind it would report a duration measured from zero. */
  mark(name: string) {
    if (this.#startedAt === null) return;
    this.#phases.push({ name, atMs: now() - this.#startedAt });
  }

  /**
   * Writes the one line, and stops this instance from writing another.
   *
   * Reported once per boot: `init()` returns early when it is already ready, and
   * a workspace switch calls `reset()` which hands back a fresh timing.
   */
  report(): void {
    if (this.#reported || this.#startedAt === null) return;
    this.#reported = true;
    const total = now() - this.#startedAt;
    const detail = this.spans();
    const summary = `boot ${Math.round(total)}ms: ${detail
      .map((s) => `${s.name} ${Math.round(s.tookMs)}ms`)
      .join(", ")}`;
    if (total >= SLOW_BOOT_MS) {
      logger.warn("boot", summary, { totalMs: Math.round(total), phases: detail });
    } else {
      logger.info("boot", summary);
    }
  }

  /**
   * Each phase and how long it took, rather than when it ended.
   *
   * The cumulative numbers are what is recorded, because a mark is a moment; the
   * difference is what anybody reading wants, because it names the phase that
   * cost the time.
   */
  spans(): { name: string; tookMs: number }[] {
    let previous = 0;
    return this.#phases.map((p) => {
      const tookMs = p.atMs - previous;
      previous = p.atMs;
      return { name: p.name, tookMs };
    });
  }

  /** Whether anything has been recorded, for a caller that wants to know before
   *  asking for a report that would say nothing. */
  get empty(): boolean {
    return this.#phases.length === 0;
  }

  /**
   * Forgets everything, so the next boot is measured on its own.
   *
   * A workspace switch is another boot. Without this it would be reported as
   * having taken since the app started, and it would be reported at `warn`
   * every time on a window that had been open for a while.
   */
  restart() {
    this.#startedAt = null;
    this.#phases = [];
    this.#reported = false;
  }
}

/** The window's own. One instance, restarted rather than replaced, so nothing
 *  depends on an imported binding changing under it. */
export const bootTiming = new BootTiming();
