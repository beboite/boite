/** Navigation keeps a prepared process briefly, even when post-turn retention is disabled. */
export const VIEW_GRACE_MS = 30_000;

export class SessionRetention {
  viewed = false;
  #prepared = false;
  #turnPrepared = false;

  prepare(forTurn = false): void {
    if (forTurn) this.#turnPrepared = true;
    else this.#prepared = true;
  }

  /** Checkpoint preparation owns only this next turn, not post-turn retention. */
  beginTurn(): void { this.#turnPrepared = false; }

  setViewed(viewed: boolean): void {
    this.viewed = viewed;
    if (viewed) this.#prepared = true;
  }

  reusable(warmMs: number, previousWarmMs: number): boolean {
    return this.#prepared || this.#turnPrepared || (warmMs > 0 && previousWarmMs > 0);
  }

  idleMs(warmMs: number): number {
    return this.#prepared || this.#turnPrepared ? Math.max(VIEW_GRACE_MS, warmMs) : warmMs;
  }
}
