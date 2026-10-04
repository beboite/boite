/*
 * A bound on what a stranger can make the core compute.
 *
 * A request on a core-to-core route is refused with 403 when it does not prove
 * who sent it, and getting there costs a key agreement or a signature check.
 * The quota of a member only starts once the request is that member's, so
 * until then the only thing to count against is where the request came from:
 * the address of the TCP peer, which cannot be forged. Past the bound that
 * address is answered 429 before its body is read, for the rest of the minute.
 *
 * Requests from this machine are not counted: a reverse proxy puts every
 * remote peer behind the one loopback address, and counting there would let
 * one stranger lock every honest machine out. A proxy has its own limits.
 */

export const REFUSALS_PER_MINUTE = 60;
const WINDOW_MS = 60_000;
/** Sources remembered at once: past it, the ones whose minute is over go. */
const SOURCES_MAX = 1024;

export class Refusals {
  private readonly bySource = new Map<string, { since: number; count: number }>();

  blocked(source: string, now = Date.now()): boolean {
    const entry = this.bySource.get(source);
    return entry !== undefined && now - entry.since <= WINDOW_MS && entry.count >= REFUSALS_PER_MINUTE;
  }

  record(source: string, now = Date.now()): void {
    const entry = this.bySource.get(source);
    if (entry !== undefined && now - entry.since <= WINDOW_MS) {
      entry.count += 1;
      return;
    }
    if (this.bySource.size >= SOURCES_MAX) {
      for (const [known, old] of this.bySource) if (now - old.since > WINDOW_MS) this.bySource.delete(known);
      // Still full of live entries: this one goes uncounted rather than the map growing without end.
      if (this.bySource.size >= SOURCES_MAX) return;
    }
    this.bySource.set(source, { since: now, count: 1 });
  }
}
