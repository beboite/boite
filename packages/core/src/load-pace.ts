import type { ThreadLoad } from '@boite/contracts';

/** The load tick while something works: a turn, a task-manager view, memory pressure, a startup or a busy process. */
export const LOAD_INTERVAL_MS = 1000;
/**
 * The load tick while every live process sits idle. Under the 5 s the
 * throttle check reads as a gap (memory-throttle-logic.ts), with room for
 * timer jitter.
 */
export const IDLE_LOAD_INTERVAL_MS = 4000;
/** A thread at or above this share of the machine keeps the tick at the fast pace. */
export const BUSY_CPU_PERCENT = 2;
/** How far a value moves before the load is worth another `thread.load`. */
const CPU_EPSILON_PERCENT = 1;
const MEMORY_EPSILON_BYTES = 1024 * 1024;

/**
 * When the next load tick runs: `fastMs` after the previous one while `fast()`
 * holds, `idleMs` otherwise. The timer never holds the process open.
 */
export class LoadPace {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dueAt = 0;
  private closed = false;

  constructor(
    private readonly tick: () => void,
    private readonly fast: () => boolean,
    private readonly fastMs: number,
    private readonly idleMs: number,
  ) {
    this.arm(fastMs);
  }

  /** Something started working: the next tick comes at the fast pace, not after an idle wait. */
  hurry(): void {
    if (this.closed || this.timer === null) return;
    if (this.dueAt - Date.now() > this.fastMs) this.arm(this.fastMs);
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(delayMs: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.dueAt = Date.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      try { this.tick(); }
      finally { if (!this.closed) this.arm(this.fast() ? this.fastMs : this.idleMs); }
    }, delayMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }
}

/** Whether a load moved enough since the last one sent to be sent again. */
export function worthPushing(previous: ThreadLoad | undefined, next: ThreadLoad): boolean {
  if (previous === undefined) return true;
  if (previous.processes !== next.processes) return true;
  if (Math.abs(previous.cpuPercent - next.cpuPercent) > CPU_EPSILON_PERCENT) return true;
  return Math.abs(previous.memoryBytes - next.memoryBytes) > MEMORY_EPSILON_BYTES;
}
