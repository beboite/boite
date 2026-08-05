import { logger } from "$lib/shared/services/logger.svelte";

/**
 * How long a thread took to light up, phase by phase.
 *
 * The log already said that a thread spawned, and never said what that cost.
 * Every complaint about Boite being slow to open a terminal ended at the same
 * place: the line is there, it carries a command and a directory, and nothing
 * in it separates a worktree copy that took four seconds from a `--resume`
 * lookup that walked a transcript store from a backend that never answered.
 * Those are three different bugs in three different files.
 *
 * One line per launch, like {@link BootTiming}, and for the same reason: a
 * phase per line, times the number of panes, times every relaunch, is the noise
 * that would get the whole thing filtered out. The phases ride in the detail.
 *
 * A launch slower than {@link SLOW_SPAWN_MS} is written at `warn` instead,
 * which puts it on the timeline next to whatever else was happening. `info`
 * from the window deliberately stays off it.
 */
export const SLOW_SPAWN_MS = 3_000;

/**
 * When a launch that has not opened yet is worth saying out loud, before it is
 * over.
 *
 * The interesting failure is not the slow one, it is the one that never lands:
 * a backend that stopped answering, a worktree wait that will not settle, a
 * remote socket that is gone. Those write nothing at all today, because the
 * line is written after the PTY comes back and that never happens. This is the
 * only signal that arrives while the thread is still stuck, so it names the
 * phase it is stuck in rather than only the thread.
 */
export const SPAWN_STALL_MS = 15_000;

/**
 * How long a PTY has to print its first byte before the line is written without
 * one.
 *
 * Time to first output is what a user calls "the terminal opened": the PTY
 * being live is invisible until something is on screen. But a shell that opens
 * on an empty prompt with no banner, or a reattach whose replay has nothing to
 * add, can legitimately print nothing, and a launch that never reports is worse
 * than one that reports `output: none`.
 */
export const FIRST_OUTPUT_DEADLINE_MS = 10_000;

/** What the launch turned out to be, which decides the verb in the line. */
export type SpawnOutcome = "spawned" | "reattached" | "failed" | "abandoned";

/** A phase name and when it finished, relative to the start of the launch. */
interface Phase {
  name: string;
  atMs: number;
}

/**
 * `performance.now()` where it exists, wall clock where it does not.
 *
 * Same reasoning as `boot-timing.ts`: these numbers are differences, and a
 * system clock that steps mid-launch would produce a negative phase.
 */
function now(): number {
  return typeof performance?.now === "function" ? performance.now() : Date.now();
}

export class SpawnTiming {
  readonly #label: string;
  #startedAt: number | null = null;
  #phases: Phase[] = [];
  #reported = false;
  #stallTimer: ReturnType<typeof setTimeout> | null = null;
  #outputTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(label: string) {
    this.#label = label;
  }

  /**
   * Starts the clock and arms the stall watchdog.
   *
   * The watchdog covers everything up to the PTY coming back, because that is
   * the whole stretch with no way out of its own: a worktree wait, a resume
   * lookup and an `open` that never resolves all look identical from here.
   */
  start() {
    if (this.#startedAt !== null) return;
    this.#startedAt = now();
    this.#stallTimer = setTimeout(() => {
      this.#stallTimer = null;
      logger.warn(
        "spawn",
        `${this.#label}: still opening after ${Math.round(SPAWN_STALL_MS / 1000)}s, stuck on ${this.#pending()}`,
        { phases: this.spans(), waitingOn: this.#pending() },
      );
    }, SPAWN_STALL_MS);
  }

  /** Records that a phase just finished. Silent before {@link start}, since a
   *  mark with no clock behind it would be measured from zero. */
  mark(name: string) {
    if (this.#startedAt === null || this.#reported) return;
    this.#phases.push({ name, atMs: now() - this.#startedAt });
  }

  /**
   * The PTY came back: the launch cannot stall any more, and what is left to
   * wait for is the first byte on screen.
   *
   * The deadline is armed here rather than at {@link start} so a launch that
   * spent its time before the PTY is not also given ten seconds of grace after
   * it.
   */
  opened(onDeadline: () => void) {
    this.#clearStall();
    if (this.#reported || this.#outputTimer !== null) return;
    this.#outputTimer = setTimeout(() => {
      this.#outputTimer = null;
      onDeadline();
    }, FIRST_OUTPUT_DEADLINE_MS);
  }

  /** Whether this launch is still waiting for its line to be written. Asked by
   *  the pane, which sees output events for PTYs it has already reported on. */
  get pendingReport(): boolean {
    return this.#startedAt !== null && !this.#reported;
  }

  /**
   * Writes the one line, and stops this instance from writing another.
   *
   * `failed` and a launch past {@link SLOW_SPAWN_MS} go to the timeline;
   * `abandoned` is a launch the pane threw away on purpose, so it is only worth
   * a debug line, which a release build drops entirely.
   */
  report(outcome: SpawnOutcome, detail?: Record<string, unknown>) {
    this.#clearStall();
    this.#clearOutput();
    if (this.#reported || this.#startedAt === null) return;
    this.#reported = true;
    const total = now() - this.#startedAt;
    const spans = this.spans();
    const summary = `${this.#label}: ${outcome} in ${Math.round(total)}ms (${spans
      .map((s) => `${s.name} ${Math.round(s.tookMs)}ms`)
      .join(", ")})`;
    const full = { totalMs: Math.round(total), phases: spans, ...detail };
    if (outcome === "abandoned") logger.debug("spawn", summary, full);
    else if (outcome === "failed") logger.error("spawn", summary, full);
    else if (total >= SLOW_SPAWN_MS) logger.warn("spawn", summary, full);
    else logger.info("spawn", summary, full);
  }

  /**
   * Drops the launch without a word.
   *
   * For a pane being destroyed: the measurement is real but nobody asked for
   * the thread any more, and a line saying a closed pane took a while to open
   * describes a window the user has already moved on from.
   */
  dispose() {
    this.#clearStall();
    this.#clearOutput();
    this.#reported = true;
  }

  /**
   * Each phase and how long it took, rather than when it ended.
   *
   * A mark is a moment; the difference is what names the phase that cost the
   * time, which is the only reason any of this is recorded.
   */
  spans(): { name: string; tookMs: number }[] {
    let previous = 0;
    return this.#phases.map((p) => {
      const tookMs = p.atMs - previous;
      previous = p.atMs;
      return { name: p.name, tookMs };
    });
  }

  /** What the launch is waiting for, which is whatever follows the last phase
   *  that finished. Named from the marks so the two can never drift. */
  #pending(): string {
    const last = this.#phases.at(-1);
    return last ? `what follows ${last.name}` : "the first phase";
  }

  #clearStall() {
    if (this.#stallTimer === null) return;
    clearTimeout(this.#stallTimer);
    this.#stallTimer = null;
  }

  #clearOutput() {
    if (this.#outputTimer === null) return;
    clearTimeout(this.#outputTimer);
    this.#outputTimer = null;
  }
}
