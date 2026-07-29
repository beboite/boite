/**
 * A reactive set of ids that forget themselves after a while.
 *
 * Two things in the app need "this just happened, say so for a moment and then
 * stop": a thread that has finished, and a surface an agent has just reached
 * through the MCP. Both are events, and both have to survive the user not
 * looking at the exact frame they arrived in — a CSS animation alone cannot do
 * that, because a row that re-renders mid-animation restarts it and a row
 * mounted after the fact never plays it at all.
 *
 * So the event is stored, not just played. `mark` writes an id, the id reads as
 * marked for `ttlMs`, and then it is gone whether or not anything was watching.
 */
export class TransientMark {
  // Value is the timer handle, so re-marking an id that is already marked
  // restarts its window rather than letting the first timer cut the second
  // short.
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #marked = $state<Record<string, true>>({});
  #ttlMs: number;

  constructor(ttlMs: number) {
    this.#ttlMs = ttlMs;
  }

  mark(id: string) {
    const existing = this.#timers.get(id);
    if (existing !== undefined) clearTimeout(existing);
    // Reassign rather than mutate when the key is new: a fresh key on a $state
    // record is tracked, but a component that read `has(id)` while the key was
    // absent is only re-run by a new object identity.
    if (!this.#marked[id]) this.#marked = { ...this.#marked, [id]: true };
    this.#timers.set(
      id,
      setTimeout(() => {
        this.#timers.delete(id);
        const next = { ...this.#marked };
        delete next[id];
        this.#marked = next;
      }, this.#ttlMs),
    );
  }

  has(id: string): boolean {
    return this.#marked[id] === true;
  }

  /** Drop a mark early — a row the user has acted on has been seen. */
  clear(id: string) {
    const existing = this.#timers.get(id);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.#timers.delete(id);
    }
    if (this.#marked[id]) {
      const next = { ...this.#marked };
      delete next[id];
      this.#marked = next;
    }
  }

  /** Every pending timer dropped. For a workspace switch, which invalidates
      every id at once. */
  reset() {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#marked = {};
  }
}
