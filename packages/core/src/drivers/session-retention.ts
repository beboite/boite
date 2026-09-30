/** Navigation keeps a prepared process briefly, even when post-turn retention is disabled. */
export const VIEW_GRACE_MS = 30_000;

export class SessionRetention {
  viewed = false;
  private prepared = false;

  setViewed(viewed: boolean): void {
    this.viewed = viewed;
    if (viewed) this.prepared = true;
  }

  reusable(warmMs: number, previousWarmMs: number): boolean {
    return this.prepared || (warmMs > 0 && previousWarmMs > 0);
  }

  idleMs(warmMs: number): number {
    return this.prepared ? Math.max(VIEW_GRACE_MS, warmMs) : warmMs;
  }
}
