import { INITIAL_MESSAGE_PAGE, type Message, type MessageId, type Thread, type ThreadId } from '@boite/contracts';
import type { StoreContext } from './context';

/**
 * Where a reader left a thread: the scroll, the measured heights, and the
 * message at the top of the view. The timeline places that message from the
 * heights whenever the list holds it, so a page read again around it lands
 * the reader where they were.
 */
export interface ReadingPosition {
  top: number;
  pinned: boolean;
  heights: Map<string, number>;
  /**
   * The message at the top of the reader's view, what the core is asked the
   * page around, and how far its top is from the list's. `row` names the row
   * the offset is measured from when the timeline cut a long message in
   * several (`lib/timeline-rows.ts`); without it, the message's first row.
   */
  anchor?: { id: string; offset: number; row?: string };
  height?: number;
  reservePrompt?: string | null;
  followPrompt?: string | null;
}

/**
 * What a page read from the core may leave there until it is looked at: long
 * tool outputs always; files, large pictures, long tool inputs and heavy
 * documents on a core that says it can hand them back one by one.
 */
export function lightPage(ctx: StoreContext): { compactTools: true; compactFiles?: true; compactImages?: true; compactToolParts?: true } {
  const features = ctx.store.core?.features;
  return {
    compactTools: true,
    ...(features?.threadSnapshots ? { compactFiles: true as const } : {}),
    ...(features?.readingPages ? { compactImages: true as const } : {}),
    // Long tool inputs and diffs too, and no message too heavy to open.
    ...(features?.deferredToolParts ? { compactToolParts: true as const } : {}),
  };
}

/** Write the cursor below a window, dropping the key once the window reaches the thread's end. */
export function setMessagesAfter(thread: Thread, after: MessageId | null | undefined): void {
  if (after) thread.messagesAfter = after;
  else delete thread.messagesAfter;
}

/**
 * The pages below a window `threads.get` cut around a reading position: the
 * mirror of `loadOlder`, and the jump to the thread's last page. A page that
 * lands after the reader left the thread, or after a newer jump, writes nothing.
 */
export class NewerPages {
  /** True while a page below the window, or the last page, is in flight. */
  loading = $state(false);
  #generation = 0;

  constructor(private readonly ctx: StoreContext) {}

  /** Navigation moved on: whatever is in flight is dropped when it lands. */
  reset(): void {
    this.#generation++;
    this.loading = false;
  }

  #begin(): { client: NonNullable<StoreContext['client']>; open: Thread; current: () => boolean } | null {
    const client = this.ctx.client;
    const open = this.ctx.threads.openThread;
    if (!client || !open || (open.messagesAfter ?? null) === null) return null;
    const generation = ++this.#generation;
    const navigation = this.ctx.threads.openGeneration;
    this.loading = true;
    return { client, open, current: () => generation === this.#generation && this.ctx.currentNavigation(client, navigation) };
  }

  /** One page of newer messages appended in place. Returns how many landed. */
  async loadNewer(): Promise<number> {
    if (this.loading) return 0;
    const run = this.#begin();
    if (!run) return 0;
    const { client, open, current } = run;
    const cursor = open.messagesAfter!;
    try {
      const page = await client.call('messages.list', { threadId: open.id, after: cursor, ...lightPage(this.ctx) });
      const still = this.ctx.threads.openThread;
      if (!current() || !still || still.id !== open.id || still.messagesAfter !== cursor) return 0;
      const known = new Set(still.messages.map((message) => message.id));
      const newer = page.messages.filter((message) => !known.has(message.id));
      still.messages.push(...newer);
      const knownTurns = new Set(still.turns.map((turn) => turn.id));
      still.turns.push(...(page.turns ?? []).filter((turn) => !knownTurns.has(turn.id)));
      setMessagesAfter(still, page.after);
      return newer.length;
    } catch (error) {
      if (current()) this.ctx.fail(error);
      return 0;
    } finally {
      if (current()) this.loading = false;
    }
  }

  /**
   * The thread's last page in place of a window cut above it: where "jump to
   * latest" goes, and what a message sent meanwhile needs to be seen.
   */
  async loadLatest(): Promise<void> {
    const run = this.#begin();
    if (!run) return;
    const { client, open, current } = run;
    try {
      const fresh = await client.call('threads.get', { threadId: open.id, limit: INITIAL_MESSAGE_PAGE, ...lightPage(this.ctx) });
      const still = this.ctx.threads.openThread;
      if (!current() || !still || still.id !== open.id) return;
      still.messages = fresh.messages;
      still.turns = fresh.turns;
      still.messagesBefore = fresh.messagesBefore;
      setMessagesAfter(still, fresh.messagesAfter);
      delete still.messagesSync;
      this.ctx.threads.readingPositions.delete(open.id);
    } catch (error) {
      if (current()) this.ctx.fail(error);
    } finally {
      if (current()) this.loading = false;
    }
  }
}

/**
 * Every attachment of `message` a light page left on the core, fetched whole
 * into the copies this client holds: Edit fills the composer from there.
 * False, with the failure shown, when one could not be read.
 */
export async function loadAttachments(ctx: StoreContext, threadId: ThreadId, message: Message): Promise<boolean> {
  try {
    await Promise.all(message.parts.map((part, index) => (part.type === 'file' || part.type === 'image') && part.dataDeferred ? ctx.threads.loadMessageAttachment(threadId, message.id, index) : undefined));
    return true;
  } catch (error) {
    ctx.fail(error);
    return false;
  }
}
