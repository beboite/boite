import { IMAGE_INLINE_CHARS, MESSAGE_PAGE, MESSAGE_PAGE_MAX, type ImagePreviews, type MessageId, type ThreadId } from '@boite/contracts';
import type { Core } from './core.ts';
import { messageOf } from './errors.ts';
import { mediaPreviews, messageIdsNear, putMediaPreview, unscannedMedia } from './journal/media-previews.ts';

/** Past this many pixels a picture gets no blur: decoding it costs more memory than the blur is worth. */
const PREVIEW_MAX_PIXELS = 7680 * 4320;
/** Blurs made at once. Each holds one decoded picture on Bun's image worker. */
const PREVIEW_CONCURRENCY = 3;
/** Base64 characters held by pictures waiting for a blur. Past this, the next read of their page asks again. */
const PREVIEW_QUEUE_CHARS = 64 * 1024 * 1024;
/** How long a page read waits for the blurs of pictures no client was sent before. */
const WARM_BUDGET_MS = 1500;

interface Job {
  threadId: string;
  messageId: string;
  partIndex: number;
  data: string;
  done: Promise<void>;
  settle: () => void;
}

/** A ThumbHash render of the picture as a PNG data URL, or null when Bun cannot decode it or refuses its size. */
export async function makePreview(data: string): Promise<string | null> {
  if (typeof Bun.Image !== 'function') return null;
  try {
    return await new Bun.Image(Buffer.from(data, 'base64'), { maxPixels: PREVIEW_MAX_PIXELS }).placeholder();
  } catch {
    return null;
  }
}

/**
 * The blur a deferred picture is drawn with until its bytes arrive. A page
 * asked with `compactImages` leaves large images on the core
 * (`previewImageData`); each keeps the size its header gives and, from here,
 * a blur that `Bun.Image.placeholder()` makes once on Bun's image worker and
 * `media_previews` keeps. A picture with none yet goes out without one and is
 * queued.
 */
export class MediaPreviews {
  private readonly waiting = new Map<string, Job>();
  private readonly running = new Map<string, Job>();
  private queuedChars = 0;

  constructor(private readonly core: Core) {}

  /** What a projection of `threadId`'s messages asks for each deferred picture. */
  lookup(threadId: string): ImagePreviews {
    let known: { messageId: string; parts: Map<number, string | null> } | null = null;
    return (messageId, partIndex, data) => {
      if (known?.messageId !== messageId) {
        try {
          known = { messageId, parts: mediaPreviews(this.core.journal.db, messageId) };
        } catch (error) {
          // A page goes out without its blurs rather than not at all.
          this.core.log('warn', `media previews of message ${messageId} could not be read: ${messageOf(error)}`);
          return null;
        }
      }
      if (known.parts.has(partIndex)) return known.parts.get(partIndex) ?? null;
      this.enqueue(threadId, messageId, partIndex, data);
      return null;
    };
  }

  /**
   * Makes the blurs of the page a `compactImages` read is about to send, for
   * messages no read looked at before, so the first opening of an old thread
   * already draws them. It covers `limit` messages on each side of `near`, or
   * the last `limit`. A message is looked at once; the wait is bounded and the
   * rest goes on in the background. Called before the page is read, never
   * between the read and the answer, so the answer still holds every event
   * sent before it.
   */
  async warm(threadId: ThreadId, near?: MessageId, limit?: number): Promise<void> {
    // The blurs are optional: a failure here never costs the reader the page.
    try {
      await this.warmPage(threadId, near, limit);
    } catch (error) {
      this.core.log('warn', `media previews for thread ${threadId} were not prepared: ${messageOf(error)}`);
    }
  }

  private async warmPage(threadId: ThreadId, near?: MessageId, limit?: number): Promise<void> {
    const journal = this.core.journal;
    if (journal.getThread(threadId) === null) return;
    const rowid = near === undefined ? null : journal.messageRowid(threadId, near);
    if (near !== undefined && rowid === null) return;
    const size = Math.min(Math.max(1, Math.trunc(Number.isFinite(limit) ? limit! : MESSAGE_PAGE)), MESSAGE_PAGE_MAX);
    const fresh = unscannedMedia(journal.db, messageIdsNear(journal.db, threadId, rowid, size));
    if (fresh.length === 0) return;
    const waits: Promise<void>[] = [];
    for (const messageId of fresh) {
      const message = journal.getMessage(messageId);
      if (message === null) continue;
      const known = mediaPreviews(journal.db, messageId);
      let complete = message.state !== 'streaming';
      message.parts.forEach((part, index) => {
        if (part.type !== 'image' || part.data.length <= IMAGE_INLINE_CHARS || known.has(index)) return;
        const done = this.enqueue(threadId, messageId, index, part.data);
        if (done === null) complete = false;
        else waits.push(done);
      });
      if (complete) putMediaPreview(journal.db, threadId, messageId, -1, null);
    }
    if (waits.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(waits),
      new Promise<void>(resolve => { timer = setTimeout(resolve, WARM_BUDGET_MS); }),
    ]);
    clearTimeout(timer);
  }

  /** The promise of that blur being written, or null when the queue is full. */
  private enqueue(threadId: string, messageId: string, partIndex: number, data: string): Promise<void> | null {
    const key = `${messageId}\0${partIndex}`;
    const existing = this.waiting.get(key) ?? this.running.get(key);
    if (existing !== undefined) return existing.done;
    if (this.queuedChars + data.length > PREVIEW_QUEUE_CHARS && this.waiting.size + this.running.size > 0) return null;
    let settle: () => void = () => undefined;
    const done = new Promise<void>(resolve => { settle = resolve; });
    this.queuedChars += data.length;
    this.waiting.set(key, { threadId, messageId, partIndex, data, done, settle });
    this.pump();
    return done;
  }

  private pump(): void {
    while (this.running.size < PREVIEW_CONCURRENCY && this.waiting.size > 0) {
      const [key, job] = this.waiting.entries().next().value as [string, Job];
      this.waiting.delete(key);
      this.running.set(key, job);
      void makePreview(job.data).then(preview => {
        if (!this.core.journal.isClosed()) putMediaPreview(this.core.journal.db, job.threadId, job.messageId, job.partIndex, preview);
      }).catch((error: unknown) => {
        this.core.log('warn', `media preview for ${job.messageId} part ${job.partIndex} failed: ${messageOf(error)}`);
      }).finally(() => {
        this.running.delete(key);
        this.queuedChars -= job.data.length;
        job.settle();
        this.pump();
      });
    }
  }
}
