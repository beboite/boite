/** What one machine of the group keeps for another until that machine took it (`delegation/remote.ts`). */
import type { CoordinationPeer } from '@boite/contracts';
import type { Core } from '../core.ts';
import { MAX_BODY, PeerRefusal } from '../coordination-wire.ts';
import { messageOf } from '../errors.ts';

const FLUSH_MS = 300;
/** A machine away is tried again after these waits, the last one repeating. */
const RETRY_MS = [5_000, 15_000, 60_000, 300_000];
/** A sealed request grows by its encryption and base64: a batch keeps well under the body a member accepts. */
const BATCH_BYTES = Math.floor(MAX_BODY * 3 / 8);

/** The oldest entries that fit one request; the rest go with the next. */
function batchOf<T>(entries: T[]): T[] {
  const batch: T[] = [];
  let size = 0;
  for (const entry of entries) {
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    if (batch.length > 0 && size + bytes > BATCH_BYTES) break;
    batch.push(entry);
    size += bytes;
  }
  return batch;
}

/**
 * What waits in the journal for one machine of the group: kept until that
 * machine took it, tried again later while it is away and at once when it
 * is heard from. A refusal is final: that machine does not want it.
 */
export class Outbox<T extends { key: string }> {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<string, number>();
  private readonly sending = new Set<string>();
  private closed = false;

  constructor(private readonly core: Core, private readonly prefix: string, private readonly deliver: (peer: CoordinationPeer, entries: T[]) => Promise<unknown>,
    private readonly merge: (kept: T, next: T) => T = (_kept, next) => next) {}

  entries(coreId: string): T[] { return (this.core.journal.getSetting(`${this.prefix}${coreId}`) as T[] | undefined) ?? []; }

  /** An entry replaces the one waiting under its key. */
  push(coreId: string, entry: T): void {
    const entries = this.entries(coreId);
    const kept = entries.find(waiting => waiting.key === entry.key);
    this.save(coreId, [...entries.filter(waiting => waiting.key !== entry.key), kept ? this.merge(kept, entry) : entry]);
    this.schedule(coreId, FLUSH_MS);
  }

  /** Withdraws an entry not sent yet. */
  remove(coreId: string, key: string): void {
    const entries = this.entries(coreId);
    if (entries.some(entry => entry.key === key)) this.save(coreId, entries.filter(entry => entry.key !== key));
  }

  /** Once the core is up: each machine something waits for. */
  start(): void {
    for (const { key } of this.core.journal.db.query('SELECT key FROM settings WHERE key GLOB ?').all(`${this.prefix}*`) as { key: string }[]) this.schedule(key.slice(this.prefix.length), FLUSH_MS);
  }

  /** That machine answers: what waited for it goes now, not after the wait its absence set. */
  heard(coreId: string): void {
    if (this.closed || this.sending.has(coreId) || this.core.journal.isClosed() || this.entries(coreId).length === 0) return;
    clearTimeout(this.timers.get(coreId));
    this.timers.delete(coreId);
    this.attempts.delete(coreId);
    this.schedule(coreId, 0);
  }

  async flush(coreId: string): Promise<void> {
    if (this.closed || this.core.journal.isClosed() || this.sending.has(coreId)) return;
    const batch = batchOf(this.entries(coreId));
    if (batch.length === 0) return;
    const peer = this.core.group.peers().find(member => member.coreId === coreId);
    // A machine that left the group hears nothing more.
    if (peer === undefined) { this.core.journal.deleteSetting(`${this.prefix}${coreId}`); return; }
    this.sending.add(coreId);
    let away = false;
    try { await this.deliver(peer, batch); }
    catch (error) {
      away = !(error instanceof PeerRefusal);
      if (!away) this.core.log('warn', `${this.prefix}${peer.name} refused ${batch.length} entries: ${messageOf(error)}`);
    } finally { this.sending.delete(coreId); }
    if (this.closed || this.core.journal.isClosed()) return;
    if (away) {
      const attempt = this.attempts.get(coreId) ?? 0;
      this.attempts.set(coreId, attempt + 1);
      this.schedule(coreId, RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!);
      return;
    }
    this.attempts.delete(coreId);
    // An entry replaced while it was on its way stays, and goes next.
    const sent = new Map(batch.map(entry => [entry.key, JSON.stringify(entry)]));
    this.save(coreId, this.entries(coreId).filter(entry => sent.get(entry.key) !== JSON.stringify(entry)));
    if (this.entries(coreId).length) this.schedule(coreId, FLUSH_MS);
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private save(coreId: string, entries: T[]): void {
    if (entries.length) this.core.journal.setSetting(`${this.prefix}${coreId}`, entries);
    else this.core.journal.deleteSetting(`${this.prefix}${coreId}`);
  }

  private schedule(coreId: string, delay: number): void {
    if (this.closed || this.timers.has(coreId)) return;
    const timer = setTimeout(() => { this.timers.delete(coreId); void this.flush(coreId).catch(error => this.core.log('warn', `${this.prefix}${coreId}: ${messageOf(error)}`)); }, delay);
    timer.unref?.();
    this.timers.set(coreId, timer);
  }
}
