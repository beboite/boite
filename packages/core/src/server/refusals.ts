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
 * An address a request was served to is a member's, and the request proved
 * which one. It keeps an allowance of its own from then on, apart from the
 * table strangers can fill, so a flood from many addresses does not turn the
 * members away with them. A member keeps a few addresses, and a new one takes
 * the place of an older one of that same member, never of another's.
 *
 * Requests from this machine are not counted: a reverse proxy puts every
 * remote peer behind the one loopback address, and counting there would let
 * one stranger lock every honest machine out. A proxy has its own limits.
 */

export const REFUSALS_PER_MINUTE = 60;
const WINDOW_MS = 60_000;
/** Strangers remembered at once. The ones there is no room for share one allowance. */
const SOURCES_MAX = 1024;
/** Addresses kept per member: a machine has a tailnet address and a LAN one, and may move. */
const ADDRESSES_PER_MEMBER = 4;
/** Members remembered. Past it a new one stays with the strangers: nobody's place is taken for it. */
const MEMBERS_MAX = 128;
/** A full table is searched for entries whose minute is over this often at most. */
const SWEEP_MS = 1000;

/** Statuses a core-to-core route answers a request it would not serve with. */
const REFUSED = new Set([403, 410, 429]);

interface Entry { since: number; refused: number; pending: number }

/**
 * What is counted as one stranger. A host on IPv6 has a whole /64 to send
 * from, so the first half of the address is the sender; an IPv4 address
 * written inside an IPv6 one is that IPv4 address.
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
  /** By exact address: a stranger in a member's /64 does not spend the member's allowance. Several members can sit behind one. */
  private readonly served = new Map<string, { entry: Entry; claims: Set<string> }>();
  /** The addresses each member was served at, oldest first. */
  private readonly members = new Map<string, string[]>();
  private readonly crowd: Entry = { since: 0, refused: 0, pending: 0 };
  private sweptAt = 0;

  constructor(private readonly sourcesMax = SOURCES_MAX) {}

  /**
   * Takes a place for one request from this address, or returns null when it
   * has none left. The function returned is called once, with the status the
   * request was answered and the machine it named: a refusal keeps the place
   * for the rest of the minute, and a request served proved that name.
   */
  begin(address: string, now = Date.now()): ((status: number, member?: string) => void) | null {
    const sender = senderOf(address);
    const entry = this.served.get(address)?.entry ?? this.stranger(sender, now);
    if (now - entry.since > WINDOW_MS) {
      entry.since = now;
      entry.refused = 0;
    }
    if (entry.refused + entry.pending >= REFUSALS_PER_MINUTE) return null;
    entry.pending += 1;
    let open = true;
    return (status, member = '') => {
      if (!open) return;
      open = false;
      entry.pending -= 1;
      if (REFUSED.has(status)) {
        entry.refused += 1;
        return;
      }
      if (status === 200 && member !== '') this.keep(address, member, now);
      // Nothing held against it: the stranger is forgotten, so the table keeps only the ones that were refused.
      if (entry.refused === 0 && entry.pending === 0 && this.strangers.get(sender) === entry) this.strangers.delete(sender);
    };
  }

  /**
   * A request of `member` was served to this address: the address gets an
   * allowance of its own, held in that member's places. It goes when the last
   * member that claims it has given its place to a newer address.
   */
  private keep(address: string, member: string, now: number): void {
    const own = this.members.get(member) ?? [];
    if (own.includes(address)) return;
    if (own.length === 0 && this.members.size >= MEMBERS_MAX) return;
    if (own.length >= ADDRESSES_PER_MEMBER) {
      const oldest = own.shift()!;
      const claims = this.served.get(oldest)?.claims;
      claims?.delete(member);
      if (claims?.size === 0) this.served.delete(oldest);
    }
    own.push(address);
    this.members.set(member, own);
    const kept = this.served.get(address);
    if (kept === undefined) this.served.set(address, { entry: { since: now, refused: 0, pending: 0 }, claims: new Set([member]) });
    else kept.claims.add(member);
  }

  private stranger(sender: string, now: number): Entry {
    const known = this.strangers.get(sender);
    if (known !== undefined) return known;
    if (this.strangers.size >= this.sourcesMax) {
      if (now - this.sweptAt >= SWEEP_MS) {
        this.sweptAt = now;
        for (const [address, old] of this.strangers) if (old.pending === 0 && now - old.since > WINDOW_MS) this.strangers.delete(address);
      }
      // Still full: this address is counted with every other the table has no room for, never left uncounted.
      if (this.strangers.size >= this.sourcesMax) return this.crowd;
    }
    const fresh = { since: now, refused: 0, pending: 0 };
    this.strangers.set(sender, fresh);
    return fresh;
  }
}
