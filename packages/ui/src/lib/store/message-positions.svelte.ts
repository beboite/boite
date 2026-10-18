import { READING_PAGE_BYTES, type Message, type MessageId, type Thread, type ThreadId, type Turn } from '@boite/contracts';
import type { StoreContext } from './context';
import { lightPage } from './reading-pages.svelte';

/** A stretch of the thread not held: where it starts, how many messages it misses. */
export interface MissingStretch { from: number; count: number }

/**
 * Where the held messages sit in their thread, and the stretches missing
 * above and between them: `first` is the position of the first one held, null
 * when the core never said; `gaps` is keyed by the held message right below
 * each stretch.
 */
export interface Placement { first: number | null; gaps: Map<MessageId, MissingStretch> }

const NONE: Placement = { first: null, gaps: new Map() };

/**
 * What every page the core sends says about where it sits (`messageOffset`,
 * `offset`), kept by message id per thread, and the pages read by position
 * that fill what is missing. A position never changes while its message
 * exists: messages only ever leave from a point to the end, so a held
 * message whose position was read once keeps it, and one that arrived live
 * sits right after the message before it. Nothing here has to follow a
 * truncation, a merge or a reload: a placement is read again from the
 * messages held. Positions are read from one core and stay with its store.
 */
export class MessagePositions {
  /** Bumped by every page noted, so a placement read before it is read again. */
  version = $state(0);
  /** True while a page read by position is in flight. */
  loading = $state(false);
  #threads = new Map<ThreadId, Map<MessageId, number>>();
  #generation = 0;

  constructor(private readonly ctx: StoreContext) {}

  /** The page `messages`, the first one at `offset`. A core that says nothing leaves nothing noted. */
  note(threadId: ThreadId, messages: readonly Message[], offset: number | undefined): void {
    if (offset === undefined || messages.length === 0) return;
    let known = this.#threads.get(threadId);
    if (known) this.#threads.delete(threadId);
    else known = new Map();
    this.#threads.set(threadId, known);
    // The threads read last stay; a store that opened a hundred threads keeps the positions of 64.
    while (this.#threads.size > 64) this.#threads.delete(this.#threads.keys().next().value!);
    messages.forEach((message, index) => known.set(message.id, offset + index));
    this.version += 1;
  }

  /**
   * `page` itself, once where it sits is noted: a thread snapshot by its
   * `messageOffset`, a `messages.list` page by its `offset`. Noted before the
   * caller decides whether to use the page: a position is a fact of the core.
   */
  noted<T extends { messages: readonly Message[]; messageOffset?: number; offset?: number }>(threadId: ThreadId, page: T): T {
    this.note(threadId, page.messages, page.messageOffset ?? page.offset);
    return page;
  }

  /** Where `messages` sit and what is missing between them. */
  placement(threadId: ThreadId, messages: readonly Message[]): Placement {
    void this.version;
    const known = this.#threads.get(threadId);
    const first = messages[0] && known?.get(messages[0].id);
    if (!known || first === undefined) return NONE;
    const gaps = new Map<MessageId, MissingStretch>();
    let previous = -1;
    for (const message of messages) {
      // A position at or before the one above it says nothing new: the message follows it.
      const at = Math.max(previous + 1, known.get(message.id) ?? previous + 1);
      if (at > previous + 1) gaps.set(message.id, { from: previous + 1, count: at - previous - 1 });
      previous = at;
    }
    return { first, gaps };
  }

  /** True when some message above the last one held is missing. */
  hasGap(thread: Thread): boolean {
    return this.placement(thread.id, thread.messages).gaps.size > 0;
  }

  /**
   * The messages from position `from` on, at most `limit` and a reading page's
   * bytes, laid into the open thread where they belong. With `below`, the held
   * message at `from + limit`, the page is read up from it instead, so a page
   * cut short by its bytes keeps the messages next to it, where a reader
   * scrolling up is. One page is in flight at a time; a page that lands after
   * the reader left is dropped. `landing` runs once the messages are in, before
   * they are drawn, for the timeline to note where the reader is and hold its
   * rows there. Returns how many messages landed.
   */
  async loadRange(from: number, limit: number, landing?: () => void, below?: MessageId): Promise<number> {
    const client = this.ctx.client;
    const open = this.ctx.threads.openThread;
    if (!client || !open || this.loading) return 0;
    // A window replaced meanwhile (the latest page, a reload) is not the one this page was read for.
    const window = open.messages;
    const generation = ++this.#generation;
    const navigation = this.ctx.threads.openGeneration;
    const current = () => generation === this.#generation && this.ctx.currentNavigation(client, navigation);
    this.loading = true;
    try {
      const page = await client.call('messages.list', { threadId: open.id, ...(below === undefined ? { from } : { before: below }), limit, maxBytes: READING_PAGE_BYTES, ...lightPage(this.ctx) });
      const still = this.ctx.threads.openThread;
      if (!current() || !still || still.id !== open.id || still.messages !== window) return 0;
      this.note(open.id, page.messages, page.offset ?? (below === undefined ? from : from + limit - page.messages.length));
      const added = this.place(still, page.messages, page.turns ?? []);
      if (added) landing?.();
      return added;
    } catch (error) {
      if (current()) this.ctx.fail(error);
      return 0;
    } finally {
      if (generation === this.#generation) this.loading = false;
    }
  }

  /**
   * The messages of a page read by position, laid in among the held ones in
   * thread order, their turns in journal order. Only what lands above the
   * last message held is kept: below it, the window's own cursor reads on.
   */
  place(thread: Thread, page: readonly Message[], turns: readonly Turn[]): number {
    const known = this.#threads.get(thread.id);
    const held = new Set(thread.messages.map((message) => message.id));
    const placed = this.placement(thread.id, thread.messages);
    if (!known || placed.first === null) return 0;
    const entries: { message: Message; at: number }[] = [];
    let at = -1;
    for (const message of thread.messages) {
      at += 1 + (placed.gaps.get(message.id)?.count ?? 0);
      entries.push({ message, at });
    }
    const last = at;
    let added = 0;
    for (const message of page) {
      const position = known.get(message.id);
      if (held.has(message.id) || position === undefined || position > last) continue;
      entries.push({ message, at: position });
      added += 1;
    }
    if (added === 0) return 0;
    entries.sort((a, b) => a.at - b.at);
    thread.messages = entries.map((entry) => entry.message);
    thread.messagesBefore = entries[0]!.at > 0 ? entries[0]!.message.id : null;
    const ids = new Set(thread.turns.map((turn) => turn.id));
    for (const turn of turns) {
      if (ids.has(turn.id)) continue;
      ids.add(turn.id);
      const later = thread.turns.findIndex((other) => other.queuedAt > turn.queuedAt);
      if (later < 0) thread.turns.push(turn);
      else thread.turns.splice(later, 0, turn);
    }
    return added;
  }
}
