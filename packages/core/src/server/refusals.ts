/*
 * A bound on what a stranger can make the core compute.
 *
 * A request on a core-to-core route is refused when it does not prove who sent
 * it, when its sender was removed, or when that sender is over its quota, and
 * getting there costs a key agreement or a signature check. The quota of a
 * member only starts once the request is that member's, so until then the only
 * thing to count against is where the request came from: the address of the
 * TCP peer, which cannot be forged. Past the bound that address is answered
 * 429 before its body is read, for the rest of the minute.
 *
 * A request counts from the moment it arrives, not from its refusal: a sender
 * that opens hundreds of requests and finishes them together would otherwise
 * pass the check hundreds of times before the first refusal is written. One
 * that is answered well gives its place back.
 *
 * Requests from this machine are not counted: a reverse proxy puts every
 * remote peer behind the one loopback address, and counting there would let
 * one stranger lock every honest machine out. A proxy has its own limits.
 */

export const REFUSALS_PER_MINUTE = 60;
const WINDOW_MS = 60_000;
/** Addresses remembered at once. The ones there is no room for share one allowance. */
const SOURCES_MAX = 1024;

/** Statuses a core-to-core route answers a request it would not serve with. */
const REFUSED = new Set([403, 410, 429]);

interface Entry { since: number; refused: number; pending: number }

export class Refusals {
  private readonly bySource = new Map<string, Entry>();
  private readonly crowd: Entry = { since: 0, refused: 0, pending: 0 };

  constructor(private readonly sourcesMax = SOURCES_MAX) {}

  static refuses(status: number): boolean {
    return REFUSED.has(status);
  }

  /**
   * Takes a place for one request from this address, or returns null when it
   * has none left. The function returned is called once, with whether the
   * request was refused: a refusal keeps the place for the rest of the minute.
   */
  begin(source: string, now = Date.now()): ((refused: boolean) => void) | null {
    const entry = this.entry(source, now);
    if (now - entry.since > WINDOW_MS) {
      entry.since = now;
      entry.refused = 0;
    }
    if (entry.refused + entry.pending >= REFUSALS_PER_MINUTE) return null;
    entry.pending += 1;
    let open = true;
    return (refused) => {
      if (!open) return;
      open = false;
      entry.pending -= 1;
      if (refused) entry.refused += 1;
      // Nothing held against it: the address is forgotten, so the table keeps only the ones that were refused.
      else if (entry.refused === 0 && entry.pending === 0 && this.bySource.get(source) === entry) this.bySource.delete(source);
    };
  }

  private entry(source: string, now: number): Entry {
    const known = this.bySource.get(source);
    if (known !== undefined) return known;
    if (this.bySource.size >= this.sourcesMax) {
      for (const [address, old] of this.bySource) if (old.pending === 0 && now - old.since > WINDOW_MS) this.bySource.delete(address);
      // Still full: this address is counted with every other the table has no room for, never left uncounted.
      if (this.bySource.size >= this.sourcesMax) return this.crowd;
    }
    const fresh = { since: now, refused: 0, pending: 0 };
    this.bySource.set(source, fresh);
    return fresh;
  }
}
