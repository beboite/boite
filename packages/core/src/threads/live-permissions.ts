import type { PermissionMode } from '@boite/contracts';
import type { TurnHandle } from '../drivers/types.ts';

/** A stalled control request must fall back to a native resume while the turn is still active. */
const UPDATE_TIMEOUT_MS = 3_000;

/** Serializes mode changes with native setters and coalesces changes during a process restart. */
export class LivePermissions {
  mode: PermissionMode;
  restarting = false;
  private handle: TurnHandle | null = null;
  private pending = Promise.resolve();
  private finished = Promise.withResolvers<void>();

  constructor(mode: PermissionMode, private readonly restart: (handle: TurnHandle) => void,
    private readonly applied: (mode: PermissionMode) => void) {
    this.mode = mode;
  }

  attach(handle: TurnHandle): void {
    this.handle = handle;
    this.finished = Promise.withResolvers<void>();
    this.restarting = false;
  }

  detach(): void {
    this.handle = null;
    this.finished.resolve();
  }

  change(mode: PermissionMode): void {
    this.mode = mode;
    const handle = this.handle;
    const finished = this.finished.promise;
    if (!handle || this.restarting) return;
    if (!handle.setPermissionMode) {
      this.replace(handle);
      return;
    }
    this.pending = this.pending.then(async () => {
      if (this.handle !== handle || this.restarting) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), UPDATE_TIMEOUT_MS); });
        timer?.unref?.();
        const applied = await Promise.race([handle.setPermissionMode!(mode), finished.then(() => null), timeout]);
        if (this.handle !== handle || applied === null) return;
        if (applied) { this.applied(mode); return; }
      } catch {
        // A refused setter cannot leave the active turn on the previous permissions.
      } finally {
        clearTimeout(timer);
      }
      this.replace(handle);
    });
  }

  async settled(): Promise<void> {
    for (;;) {
      const pending = this.pending;
      await pending;
      if (pending === this.pending) return;
    }
  }

  private replace(handle: TurnHandle): void {
    if (this.handle !== handle || this.restarting) return;
    this.restarting = true;
    this.restart(handle);
  }
}
