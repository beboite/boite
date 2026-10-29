/**
 * A resource read whole and kept current by events, such as the plugins or the
 * devices of a thread. Events that arrive while a read is out wait and are
 * applied after its answer, so an answer computed before them never undoes
 * them; an answer to a read sent before the last one applied is dropped. The
 * caller subscribes through `push` before the first read and disposes the feed
 * with its client.
 */
export class SnapshotFeed<E> {
  #out = 0;
  #started = 0;
  #applied = 0;
  #held: { event: E; after: number }[] = [];
  #disposed = false;

  constructor(private readonly apply: (event: E) => void) {}

  /** An event from the subscription. */
  push(event: E): void {
    if (this.#disposed) return;
    if (this.#out === 0) this.apply(event);
    else this.#held.push({ event, after: this.#started });
  }

  /**
   * Reads the whole resource and hands the answer to `snapshot`, unless a later
   * read already answered. Rejects with the read's error, after the events held
   * meanwhile are applied.
   */
  async read<S>(load: () => Promise<S>, snapshot: (value: S) => void): Promise<void> {
    const mine = ++this.#started;
    this.#out++;
    try {
      const value = await load();
      if (this.#disposed || mine < this.#applied) return;
      this.#applied = mine;
      snapshot(value);
    } finally {
      this.#out--;
      if (this.#out === 0) this.#release();
    }
  }

  /** Stops applying anything: the client this feed listened to is gone. */
  dispose(): void {
    this.#disposed = true;
    this.#held = [];
  }

  /** Events that came after the last answer's read was sent; older ones are already in it. */
  #release(): void {
    const held = this.#held;
    this.#held = [];
    if (this.#disposed) return;
    for (const { event, after } of held) if (after >= this.#applied) this.apply(event);
  }
}
