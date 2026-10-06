import {
  MEDIA_SLOT_PATTERN,
  MESSAGE_PAGE,
  MESSAGE_PAGE_MAX,
  mediaAt,
  messageWithMediaRefs,
  partWithMediaRefs,
  type MediaPreviews,
  type Message,
  type MessageId,
  type RpcEventName,
  type RpcEvents,
  type Thread,
  type ThreadId,
  type ThreadRewind,
} from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, messageOf, notFound } from './errors.ts';

/** Past this many pixels a picture gets no blur: decoding it costs more memory than the blur is worth. */
const PREVIEW_MAX_PIXELS = 7680 * 4320;
/** Blurs made at once. Each holds one decoded picture on Bun's image worker. */
const PREVIEW_CONCURRENCY = 3;
/** Base64 characters held by pictures waiting for a blur. Past this, the next read of their page asks again. */
const PREVIEW_QUEUE_CHARS = 64 * 1024 * 1024;
/** How long a page read waits for the blurs of pictures no client looked at before. */
const WARM_BUDGET_MS = 1500;

interface Job {
  threadId: string;
  messageId: string;
  slot: string;
  data: string;
  done: Promise<void>;
  settle: () => void;
}

/** A ThumbHash render of the picture, or null when Bun cannot decode it or refuses its size. */
export async function makePreview(data: string): Promise<string | null> {
  if (typeof Bun.Image !== 'function') return null;
  try {
    return await new Bun.Image(Buffer.from(data, 'base64'), { maxPixels: PREVIEW_MAX_PIXELS }).placeholder();
  } catch {
    return null;
  }
}

/**
 * The bytes of images and files leave a message on their way to a client that
 * said hello with `media: 'ref'`, and come back one at a time through
 * `messages.media`. What is left in their place is a `MediaRef`: the size,
 * read from the header on every send, and a blur, made once per picture on
 * Bun's image worker and kept in `media_previews`.
 *
 * The journal keeps every byte where it was: drivers, imports, rewinds and the
 * CLI read messages whole. Only the socket of a client that asked is spared.
 */
export class MediaIndex {
  private readonly waiting = new Map<string, Job>();
  private readonly running = new Map<string, Job>();
  private queuedChars = 0;
  /** One stripped copy of an event payload, shared by every socket it goes to. */
  private readonly wired = new WeakMap<object, unknown>();

  constructor(private readonly core: Core) {}

  /** What a media client is sent for `method`'s answer; anything else goes through untouched. */
  result(method: string, result: unknown): unknown {
    switch (method) {
      case 'threads.get':
        return this.thread(result as Thread);
      case 'messages.list': {
        const page = result as { messages: Message[] };
        return { ...page, messages: page.messages.map((message) => this.message(message)) };
      }
      case 'threads.rewind': {
        // The removed message's attachments keep their bytes: the composer sends them again.
        const rewind = result as ThreadRewind;
        return { ...rewind, thread: this.thread(rewind.thread) };
      }
      case 'artifacts.publish':
        return this.message(result as Message);
      default:
        return result;
    }
  }

  /** The event a media client is sent; the same payload object when it carries no bytes. */
  event<E extends RpcEventName>(name: E, payload: RpcEvents[E]): RpcEvents[E] {
    if (name !== 'message.started' && name !== 'message.part') return payload;
    const held = this.wired.get(payload as object);
    if (held !== undefined) return held as RpcEvents[E];
    let next: unknown = payload;
    if (name === 'message.started') {
      next = this.message(payload as Message);
    } else {
      const event = payload as RpcEvents['message.part'];
      const part = partWithMediaRefs(event.part, event.partIndex, event.messageId, this.previews(event.threadId));
      if (part !== event.part) next = { ...event, part };
    }
    this.wired.set(payload as object, next);
    return next as RpcEvents[E];
  }

  thread(thread: Thread): Thread {
    return { ...thread, messages: thread.messages.map((message) => this.message(message)) };
  }

  message(message: Message): Message {
    return messageWithMediaRefs(message, this.previews(message.threadId));
  }

  /**
   * The blurs the journal holds, read once per message and only for one that
   * has a picture. A picture with none is queued, and goes out without one.
   */
  private previews(threadId: string): MediaPreviews {
    let known: { messageId: string; slots: Map<string, string | null> } | null = null;
    return (messageId, slot, _mimeType, data) => {
      if (known?.messageId !== messageId) known = { messageId, slots: this.core.journal.mediaPreviews(messageId) };
      if (known.slots.has(slot)) return known.slots.get(slot) ?? null;
      this.enqueue(threadId, messageId, slot, data);
      return null;
    };
  }

  /**
   * Makes the blurs of the page `threads.get` or `messages.list` is about to
   * read, for the pictures of messages no client was sent before, so the first
   * opening of an old thread already draws them. A message is looked at once;
   * the wait is bounded and what is left keeps going in the background. Called
   * before the page is read, never between the read and the answer: events
   * keep flowing while it waits, and the answer has to hold every one of them.
   */
  async warm(threadId: ThreadId, before?: MessageId, limit?: number): Promise<void> {
    const journal = this.core.journal;
    if (journal.getThread(threadId) === null) return;
    let beforeRowid: number | null = null;
    if (before !== undefined) {
      beforeRowid = journal.messageRowid(threadId, before);
      if (beforeRowid === null) return;
    }
    const size = Math.min(Math.max(1, Math.trunc(limit ?? MESSAGE_PAGE)), MESSAGE_PAGE_MAX);
    const fresh = journal.unscannedMedia(journal.messageIdsBefore(threadId, beforeRowid, size));
    if (fresh.length === 0) return;
    const waits: Promise<void>[] = [];
    for (const messageId of fresh) {
      const message = journal.getMessage(messageId);
      if (message === null) continue;
      const known = journal.mediaPreviews(messageId);
      let complete = message.state !== 'streaming';
      messageWithMediaRefs(message, (id, slot, _mimeType, data) => {
        if (known.has(slot)) return null;
        const done = this.enqueue(threadId, id, slot, data);
        if (done === null) complete = false;
        else waits.push(done);
        return null;
      });
      // A message still streaming can gain a tool image; it is looked at again.
      if (complete) journal.putMediaPreview(threadId, messageId, '', null);
    }
    if (waits.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(waits),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, WARM_BUDGET_MS); }),
    ]);
    clearTimeout(timer);
  }

  /** `messages.media`: the bytes of one slot, refused by field when the message or the slot holds none. */
  read(params: { threadId: ThreadId; messageId: MessageId; slot: string }): { mimeType: string; data: string } {
    this.core.threads.require(params.threadId);
    if (typeof params.slot !== 'string' || !MEDIA_SLOT_PATTERN.test(params.slot)) {
      throw invalidParams('slot: expected p<part> or p<part>d<document>, as a MediaRef names it', { field: 'slot', slot: params.slot });
    }
    const message = this.core.journal.getMessage(params.messageId);
    if (message === null || message.threadId !== params.threadId) {
      throw notFound(`message ${params.messageId} is not a message of thread ${params.threadId}`, {
        field: 'messageId', messageId: params.messageId, threadId: params.threadId,
      });
    }
    const found = mediaAt(message, params.slot);
    if (found === null) {
      throw notFound(`slot ${params.slot} of message ${params.messageId} holds no image or file`, { field: 'slot', slot: params.slot });
    }
    return found;
  }

  /** The promise of that blur being written, or null when the queue is full. */
  private enqueue(threadId: string, messageId: string, slot: string, data: string): Promise<void> | null {
    const key = `${messageId}\0${slot}`;
    const existing = this.waiting.get(key) ?? this.running.get(key);
    if (existing !== undefined) return existing.done;
    if (this.queuedChars + data.length > PREVIEW_QUEUE_CHARS && this.waiting.size + this.running.size > 0) return null;
    let settle: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { settle = resolve; });
    this.queuedChars += data.length;
    this.waiting.set(key, { threadId, messageId, slot, data, done, settle });
    this.pump();
    return done;
  }

  private pump(): void {
    while (this.running.size < PREVIEW_CONCURRENCY && this.waiting.size > 0) {
      const [key, job] = this.waiting.entries().next().value as [string, Job];
      this.waiting.delete(key);
      this.running.set(key, job);
      void makePreview(job.data).then((preview) => {
        // Gone with the core or with its message: nothing to keep.
        if (!this.core.journal.isClosed()) this.core.journal.putMediaPreview(job.threadId, job.messageId, job.slot, preview);
      }).catch((error: unknown) => {
        this.core.log('warn', `media preview for ${job.messageId} ${job.slot} failed: ${messageOf(error)}`);
      }).finally(() => {
        this.running.delete(key);
        this.queuedChars -= job.data.length;
        job.settle();
        this.pump();
      });
    }
  }
}
