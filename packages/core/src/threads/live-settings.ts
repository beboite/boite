import type { LiveTurnSettings, TurnHandle } from '../drivers/types.ts';

/** A setter that never answers must not hold the changes queued behind it. */
const UPDATE_TIMEOUT_MS = 3_000;

/** The effort and the speed a running turn is on, or should move to. */
export interface TurnSettings {
  effort: string | null;
  speed: string | null;
}

/**
 * Carries an effort or speed change to the running native turn. Changes are
 * sent one at a time and each one is the difference between what the turn is
 * on and the latest selection, so a slider dragged across several levels ends
 * on the last one. A driver with no setter, or one that declines a field,
 * leaves that field for the next turn: nothing here ever restarts a turn.
 */
export class LiveSettings {
  private handle: TurnHandle | null = null;
  private wanted: TurnSettings | null = null;
  private pending = Promise.resolve();
  private finished = Promise.withResolvers<void>();

  constructor(private readonly current: () => TurnSettings, private readonly applied: (taken: LiveTurnSettings) => void) {}

  attach(handle: TurnHandle): void {
    this.handle = handle;
    this.finished = Promise.withResolvers<void>();
  }

  detach(): void {
    this.handle = null;
    this.finished.resolve();
  }

  change(wanted: TurnSettings): void {
    this.wanted = wanted;
    const handle = this.handle;
    const finished = this.finished.promise;
    if (!handle?.applySettings) return;
    this.pending = this.pending.then(async () => {
      if (this.handle !== handle || this.wanted === null) return;
      const change = difference(this.current(), this.wanted);
      if (change === null) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), UPDATE_TIMEOUT_MS); });
        timer?.unref?.();
        const taken = await Promise.race([handle.applySettings!(change), finished.then(() => null), timeout]);
        if (this.handle !== handle || taken === null) return;
        // Only what was asked for counts, whatever else the driver names.
        const kept: LiveTurnSettings = {};
        if ('effort' in change && 'effort' in taken) kept.effort = change.effort ?? null;
        if ('speed' in change && 'speed' in taken) kept.speed = change.speed ?? null;
        if ('effort' in kept || 'speed' in kept) this.applied(kept);
      } catch {
        // A refused setter leaves the turn as it started; the next turn carries the selection.
      } finally {
        clearTimeout(timer);
      }
    });
  }

  async settled(): Promise<void> {
    for (;;) {
      const pending = this.pending;
      await pending;
      if (pending === this.pending) return;
    }
  }
}

function difference(from: TurnSettings, to: TurnSettings): LiveTurnSettings | null {
  const change: LiveTurnSettings = {};
  if (to.effort !== from.effort) change.effort = to.effort;
  if (to.speed !== from.speed) change.speed = to.speed;
  return 'effort' in change || 'speed' in change ? change : null;
}
