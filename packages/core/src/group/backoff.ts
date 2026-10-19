/**
 * Members that did not answer the last roster offer: when to offer them again,
 * doubling from `firstMs` up to `maxMs`, and the roster digest they were
 * offered. A different roster goes out at once, and any signed request from
 * the member ends its wait. A round that finds an offer of the same roster
 * still on its way waits for that one instead of sending it again: two rounds
 * that overlap (a change and the tick) would count two failures for one
 * silence and double the wait.
 */
export class SyncBackoff {
  private readonly waits = new Map<string, { failures: number; nextAt: number; digest: string }>();
  private readonly sending = new Map<string, Promise<void>>();

  constructor(private readonly firstMs: number, private readonly maxMs: number) {}

  failed(coreId: string, digest: string, now = Date.now()): void {
    const failures = (this.waits.get(coreId)?.failures ?? 0) + 1;
    this.waits.set(coreId, { failures, digest, nextAt: now + Math.min(this.firstMs * 2 ** failures, this.maxMs) });
  }

  /** The member answered, or asked something itself: it is up. */
  heard(coreId: string): void {
    this.waits.delete(coreId);
  }

  waiting(coreId: string, digest: string, now = Date.now()): boolean {
    const wait = this.waits.get(coreId);
    return wait !== undefined && wait.digest === digest && wait.nextAt > now;
  }

  /** Offers `digest` to the member with `send`, or gives the offer of it already on its way. */
  offer(coreId: string, digest: string, send: () => Promise<void>): Promise<void> {
    const key = `${coreId} ${digest}`;
    let offer = this.sending.get(key);
    if (offer === undefined) {
      offer = send().finally(() => this.sending.delete(key));
      this.sending.set(key, offer);
    }
    return offer;
  }

  clear(): void {
    this.waits.clear();
  }
}
