import { DISPLAY_IMAGE_MAX, IMAGE_INLINE_CHARS, MESSAGE_PAGE, MESSAGE_PAGE_MAX, type ImagePreviews, type MessageId, type ThreadId } from '@boite/contracts';
import type { Core } from './core.ts';
import { messageOf } from './errors.ts';
import { mediaDisplay, mediaPreviews, messageIdsNear, putMediaDisplay, putMediaPreview, unscannedMedia } from './journal/media-previews.ts';

/** Past this many pixels a picture gets no blur: decoding it costs more memory than the blur is worth. */
const PREVIEW_MAX_PIXELS = 7680 * 4320;
/** Blurs made at once. Each holds one decoded picture on Bun's image worker. */
const PREVIEW_CONCURRENCY = 3;
/** Base64 characters held by pictures waiting for a blur. Past this, the next read of their page asks again. */
const PREVIEW_QUEUE_CHARS = 64 * 1024 * 1024;
/** How long a page read waits for the blurs of pictures no client was sent before. */
const WARM_BUDGET_MS = 1500;

/** WebP copies made at once. Each decodes one picture on Bun's image worker, about 130 ms for a 1920 by 1080 screenshot. */
const DISPLAY_CONCURRENCY = 2;
/** What `messages.attachment` with `display` converts. A GIF keeps its frames by staying as it is. */
const DISPLAY_TYPES = /^image\/(png|jpeg|webp)$/;

/**
 * The copy of a picture the timeline draws: WebP at quality 80, its longer
 * side at most `DISPLAY_IMAGE_MAX`. Measured on 2026-10-07, 1.5 to 2.5 MB PNG
 * screenshots became 50 to 130 KB. Null when Bun cannot decode it or refuses
 * its size; AVIF would be smaller still, but Bun's Linux build cannot encode it.
 */
export async function makeDisplay(data: string): Promise<Uint8Array | null> {
  if (typeof Bun.Image !== 'function') return null;
  try {
    return await new Bun.Image(Buffer.from(data, 'base64'), { maxPixels: PREVIEW_MAX_PIXELS })
      .resize(DISPLAY_IMAGE_MAX, DISPLAY_IMAGE_MAX, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .bytes();
  } catch {
    return null;
  }
}

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
  /** WebP copies being made, one promise per picture however many clients ask. */
  private readonly displays = new Map<string, Promise<Uint8Array>>();
  private displaying = 0;
  private readonly displayTurns: (() => void)[] = [];

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
        const picture = part.type === 'image' || (part.type === 'file' && /^image\/(png|jpeg|gif|webp)$/.test(part.mimeType));
        if (!picture || part.data.length <= IMAGE_INLINE_CHARS || known.has(index)) return;
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

  /**
   * The WebP copy of a picture for `messages.attachment` with `display`, made
   * once and kept in `media_displays`; null when the original is what to send:
   * a GIF or another type, a picture Bun cannot convert, or one whose copy
   * would not be lighter.
   */
  async display(threadId: string, messageId: string, partIndex: number, mimeType: string, data: string): Promise<{ data: string; mimeType: string } | null> {
    if (!DISPLAY_TYPES.test(mimeType)) return null;
    const db = this.core.journal.db;
    let held: Uint8Array | null = null;
    try {
      held = mediaDisplay(db, messageId, partIndex);
    } catch (error) {
      this.core.log('warn', `display copy of message ${messageId} part ${partIndex} could not be read: ${messageOf(error)}`);
    }
    if (held === null) {
      const key = `${messageId}\0${partIndex}`;
      let made = this.displays.get(key);
      if (made === undefined) {
        made = this.displayTurn(() => makeDisplay(data)).then(copy => {
          // The original wins when it is already as light: a small PNG icon, a WebP sent as one.
          const kept = copy !== null && copy.length < data.length * 3 / 4 ? copy : new Uint8Array(0);
          try {
            if (!this.core.journal.isClosed()) putMediaDisplay(db, threadId, messageId, partIndex, kept);
          } catch (error) {
            this.core.log('warn', `display copy of message ${messageId} part ${partIndex} was not kept: ${messageOf(error)}`);
          }
          return kept;
        }).finally(() => this.displays.delete(key));
        this.displays.set(key, made);
      }
      held = await made;
    }
    return held.length === 0 ? null : { data: Buffer.from(held).toString('base64'), mimeType: 'image/webp' };
  }

  /** Runs `work` once fewer than `DISPLAY_CONCURRENCY` copies are being made. */
  private async displayTurn<T>(work: () => Promise<T>): Promise<T> {
    if (this.displaying >= DISPLAY_CONCURRENCY) await new Promise<void>(resolve => this.displayTurns.push(resolve));
    this.displaying += 1;
    try {
      return await work();
    } finally {
      this.displaying -= 1;
      this.displayTurns.shift()?.();
    }
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
