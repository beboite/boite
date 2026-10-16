/**
 * Members that did not answer the last roster offer: when to offer them again,
 * doubling from `firstMs` up to `maxMs`, and the roster digest they were
 * offered. A different roster goes out at once, and any signed request from
 * the member ends its wait.
 */
export class SyncBackoff {
  private readonly waits = new Map<string, { failures: number; nextAt: number; digest: string }>();

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

  clear(): void {
    this.waits.clear();
  }
}
