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
 * An address a request was served to is a member's. It keeps an allowance of
 * its own from then on, apart from the table strangers can fill, so a flood
 * from many addresses does not turn the members away with them.
 *
 * Requests from this machine are not counted: a reverse proxy puts every
 * remote peer behind the one loopback address, and counting there would let
 * one stranger lock every honest machine out. A proxy has its own limits.
 */

export const REFUSALS_PER_MINUTE = 60;
const WINDOW_MS = 60_000;
/** Strangers' addresses remembered at once. The ones there is no room for share one allowance. */
const SOURCES_MAX = 1024;
/** Addresses a request was served to, the most recent kept. A group holds 32 machines. */
const SERVED_MAX = 128;

/** Statuses a core-to-core route answers a request it would not serve with. */
const REFUSED = new Set([403, 410, 429]);

interface Entry { since: number; refused: number; pending: number }

/**
 * What is counted as one sender. A host on IPv6 has a whole /64 to send from,
 * so the first half of the address is the sender; an IPv4 address written
 * inside an IPv6 one is that IPv4 address.
 */
export function senderOf(address: string): string {
  const plain = address.split('%')[0]!.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(plain);
  if (mapped) return mapped[1]!;
  if (!plain.includes(':')) return plain;
  const [head = '', tail] = plain.split('::');
  const first = head === '' ? [] : head.split(':');
  const last = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups = tail === undefined ? first : [...first, ...Array.from({ length: Math.max(0, 8 - first.length - last.length) }, () => '0'), ...last];
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export class Refusals {
  private readonly strangers = new Map<string, Entry>();
  private readonly served = new Map<string, Entry>();
  private readonly crowd: Entry = { since: 0, refused: 0, pending: 0 };

  constructor(private readonly sourcesMax = SOURCES_MAX) {}

  /**
   * Takes a place for one request from this address, or returns null when it
   * has none left. The function returned is called once, with the status the
   * request was answered: a refusal keeps the place for the rest of the minute.
   */
  begin(address: string, now = Date.now()): ((status: number) => void) | null {
    const sender = senderOf(address);
    const entry = this.served.get(sender) ?? this.stranger(sender, now);
    if (now - entry.since > WINDOW_MS) {
      entry.since = now;
      entry.refused = 0;
    }
    if (entry.refused + entry.pending >= REFUSALS_PER_MINUTE) return null;
    entry.pending += 1;
    let open = true;
    return (status) => {
      if (!open) return;
      open = false;
      entry.pending -= 1;
      if (REFUSED.has(status)) entry.refused += 1;
      else if (status === 200) this.keep(sender, entry, now);
      // Nothing held against it: the address is forgotten, so the table keeps only the ones that were refused.
      else if (entry.refused === 0 && entry.pending === 0 && this.strangers.get(sender) === entry) this.strangers.delete(sender);
    };
  }

  /** A request was served to this address: it leaves the strangers' table for an allowance nobody else can use up. */
  private keep(sender: string, entry: Entry, now: number): void {
    const own = entry === this.crowd ? { since: now, refused: 0, pending: 0 } : entry;
    this.strangers.delete(sender);
    this.served.delete(sender);
    this.served.set(sender, own);
    if (this.served.size > SERVED_MAX) this.served.delete(this.served.keys().next().value!);
  }

  private stranger(sender: string, now: number): Entry {
    const known = this.strangers.get(sender);
    if (known !== undefined) return known;
    if (this.strangers.size >= this.sourcesMax) {
      for (const [address, old] of this.strangers) if (old.pending === 0 && now - old.since > WINDOW_MS) this.strangers.delete(address);
      // Still full: this address is counted with every other the table has no room for, never left uncounted.
      if (this.strangers.size >= this.sourcesMax) return this.crowd;
    }
    const fresh = { since: now, refused: 0, pending: 0 };
    this.strangers.set(sender, fresh);
    return fresh;
  }
}
