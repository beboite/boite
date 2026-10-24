/*
 * The page `open()` asks for, and the presses that ask for it ahead of their
 * click (`lib/press-preload.ts`).
 *
 * A press sends what the open would send, built by the same `askPage`, with
 * the subscription and without the open's other effects: a core with bundled
 * snapshots gets `open: { requests: false }`, so it neither leaves the thread
 * on screen nor marks anything read nor reads requests. The open that follows
 * claims the press and does those itself, after the page. Until the page is on
 * screen, events patch it like the open thread (`Threads.threadSnapshots`).
 */

import { INITIAL_MESSAGE_PAGE, INITIAL_PAGE_BYTES, MESSAGE_PAGE_MAX, type MessageId, type Thread, type ThreadId, type ThreadSnapshot } from '@boite/contracts';
import type { Client } from '../client';
import { resumeRequest } from '../thread-rows';
import type { StoreContext } from './context';
import { lightPage, type ReadingPosition } from './reading-pages.svelte';

/** What `open()` sends for a thread: the page and, before bundled snapshots, the subscription. */
export interface PageAsk {
  subscribed: Promise<unknown> | null;
  fetched: Promise<ThreadSnapshot>;
  /** The reader's message the page is centred on, when it is. */
  around: MessageId | undefined;
}

/** A press waiting for its click, or claimed by the open it became. */
export interface Preload extends PageAsk {
  threadId: ThreadId;
  client: Client;
  held: Thread | undefined;
  thread: Thread | null;
  /** Its subscribe or page was refused: the open asks again rather than inherit the failure. */
  failed: boolean;
  summaryRead: ReturnType<StoreContext['threadReads']['begin']>;
}

/** What a press reads of the thread store. */
export interface Opener {
  readonly subscribedThreadId: ThreadId | null;
  readonly openThread: Thread | null;
  readonly openTarget: ThreadId | null;
  readonly readingThreads: { get(threadId: string): Thread | undefined };
  readonly readingPositions: Map<string, ReadingPosition>;
  loadingThreadId: ThreadId | null;
  loadingBytes: { threadId: ThreadId; received: number; total: number } | null;
}

/**
 * The page and subscription for `threadId`. A recent visit asks only for what
 * it cannot vouch for, a long thread left away from its end opens around the
 * reader's message, and a bundled core subscribes in the same call with `open`.
 * `current` says whether the loading view may still count the page in.
 */
export function askPage(ctx: StoreContext, opener: Opener, client: Client, threadId: ThreadId, held: Thread | undefined, open: { previous?: ThreadId; requests?: boolean; markRead?: boolean }, current: () => boolean): PageAsk {
  const features = ctx.store.core?.features;
  const bundled = features?.threadSnapshots === true;
  const subscribed = bundled ? null : client.call('threads.subscribe', { threadId });
  // A thread already in hand, open or among the recent ones, asks only for
  // what it cannot vouch for: a reconnect on a long conversation used to
  // download its last 120 messages again for the two that were new.
  const resume = resumeRequest(threadId, held);
  // A long thread left away from its end opens where the reader was: the
  // page around the message at the top of their view, not the last one.
  const saved = held || !features?.readingPages ? undefined : opener.readingPositions.get(threadId);
  const around = saved && !saved.pinned ? saved.anchor?.id : undefined;
  // A page holds about one screen; the rest comes as the reader scrolls. A resume tail is never cut.
  const fetched = client.call('threads.get', { ...resume, limit: held ? MESSAGE_PAGE_MAX : INITIAL_MESSAGE_PAGE, maxBytes: INITIAL_PAGE_BYTES, ...lightPage(ctx), ...(around ? { around } : {}),
    ...(bundled ? { sync: held?.messagesSync && held.messagesSync.from === resume.after ? held.messagesSync : true, open } : {})
  }, held || !features?.chunkedAnswers ? {} : {
    // The loading view counts the page in as the core slices it.
    onProgress: (received, total) => { if (current() && opener.loadingThreadId === threadId) opener.loadingBytes = { threadId, received, total }; }
  });
  // Where the page sits, noted as it lands, whichever open or press ends up using it.
  void fetched.then((thread) => ctx.positions.note(threadId, thread.messages, thread.messageOffset), () => undefined);
  return { subscribed, fetched, around };
}

export class ThreadPreloads {
  /** The press waiting for its click, at most one. */
  #waiting: Preload | null = null;
  /** The press an `open()` took over, patched by events until its page is on screen. */
  #claimed: Preload | null = null;

  constructor(private readonly ctx: StoreContext, private readonly opener: Opener) {}

  /**
   * Asks for `threadId`'s page and subscription now. Answers the release, for
   * a press that never becomes an open: it gives the subscription back unless
   * something came to hold it meanwhile. A newer press releases the older.
   */
  preload(threadId: ThreadId): () => void {
    const client = this.ctx.client;
    const waiting = this.#waiting;
    if (waiting && waiting.threadId === threadId && waiting.client === client) return () => this.#release(waiting);
    this.#release(waiting);
    // The thread on screen is live already; a machine switched away from keeps
    // its last thread unsubscribed, and a press on it preloads like any other.
    if (!client || this.ctx.store.connection !== 'ready' || this.opener.subscribedThreadId === threadId) return () => {};
    const held = this.opener.openThread?.id === threadId ? this.opener.openThread : this.opener.readingThreads.get(threadId);
    const summaryRead = this.ctx.threadReads.begin(threadId);
    let preload: Preload | null = null;
    const ask = askPage(this.ctx, this.opener, client, threadId, held, { requests: false }, () => preload !== null && this.#claimed === preload);
    const made: Preload = { ...ask, threadId, client, held, thread: null, failed: false, summaryRead };
    const failed = () => { made.failed = true; };
    ask.subscribed?.catch(failed);
    ask.fetched.catch(failed);
    preload = made;
    this.#waiting = made;
    void ask.fetched.then((thread) => { made.thread = thread; }, () => undefined);
    return () => this.#release(made);
  }

  /** The waiting press on `threadId`, from this socket and the same visit, handed to the open asking for it. */
  claim(threadId: ThreadId, client: Client, held: Thread | undefined): Preload | null {
    const waiting = this.#waiting;
    if (!waiting || waiting.threadId !== threadId) return null;
    this.#waiting = null;
    if (waiting.client !== client || waiting.held !== held || waiting.failed) {
      this.giveBack(waiting);
      return null;
    }
    this.#claimed = waiting;
    return waiting;
  }

  /** The open showed the claimed page, or gave up on it: events stop patching it. */
  done(preload: Preload | null): void {
    if (preload && this.#claimed === preload) this.#claimed = null;
  }

  /** Unsubscribes a press nobody opened, unless the thread is held by now. */
  giveBack(preload: Preload): void {
    preload.summaryRead.cancel();
    const { threadId, client } = preload;
    void (preload.subscribed ?? preload.fetched).then(() => {
      if (client !== this.ctx.client || this.holds(threadId) || this.opener.openTarget === threadId) return;
      if (this.ctx.delegation.delegationSubscribedThreadId === threadId) return;
      return client.call('threads.unsubscribe', { threadId });
    }).catch(() => undefined);
  }

  /** Whether this side keeps `threadId` subscribed: the open thread, or a press on its way to opening it. */
  holds(threadId: ThreadId): boolean {
    return this.opener.subscribedThreadId === threadId || this.#waiting?.threadId === threadId || this.#claimed?.threadId === threadId;
  }

  /** The thread a press waits on, which an open leaving another thread must not unsubscribe. */
  get waitingThreadId(): ThreadId | undefined {
    return this.#waiting?.threadId;
  }

  /** The pages presses loaded, which events patch beside the open thread. */
  pages(): (Thread | null | undefined)[] {
    return [this.#waiting?.thread, this.#claimed?.thread];
  }

  /** The page a press loaded for `threadId`, for the events that patch only the open thread. */
  thread(threadId: ThreadId): Thread | null {
    for (const page of this.pages()) if (page?.id === threadId) return page;
    return null;
  }

  #release(preload: Preload | null): void {
    if (!preload || this.#waiting !== preload) return;
    this.#waiting = null;
    this.giveBack(preload);
  }
}
