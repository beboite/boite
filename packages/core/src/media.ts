import { DISPLAY_IMAGE_MAX, DISPLAY_THUMB_MAX, type ImagePreviews } from '@boite/contracts';
import type { Core } from './core.ts';
import { messageOf } from './errors.ts';
import { mediaDisplay, mediaPreviews, putMediaDisplay, putMediaPreview } from './journal/media-previews.ts';

/** Past this many pixels a picture gets no blur: decoding it costs more memory than the blur is worth. */
const PREVIEW_MAX_PIXELS = 7680 * 4320;
/** Blurs made at once. Each holds one decoded picture on Bun's image worker. */
const PREVIEW_CONCURRENCY = 3;
/** Base64 characters held by pictures waiting for a blur. Past this, the next read of their page asks again. */
const PREVIEW_QUEUE_CHARS = 64 * 1024 * 1024;

/** WebP copies made at once. Each decodes one picture on Bun's image worker, about 130 ms for a 1920 by 1080 screenshot. */
const DISPLAY_CONCURRENCY = 2;
/** What `messages.attachment` with `display` converts. A GIF keeps its frames by staying as it is. */
export const DISPLAY_TYPES = /^image\/(png|jpeg|webp)$/;

/** Which copy: the one the timeline draws, or the one a prompt's thumbnail draws. */
export type DisplaySize = 'large' | 'thumb';
const DISPLAY_SIZES: Record<DisplaySize, { max: number; quality: number }> = {
  large: { max: DISPLAY_IMAGE_MAX, quality: 80 },
  thumb: { max: DISPLAY_THUMB_MAX, quality: 75 },
};

/**
 * The `media_displays` row a copy is kept in. The large copy keeps the part's
 * own index and a thumbnail's goes to `-2 - partIndex`, so the table needs no
 * size column and the deletes of a thread or a rewind, which go by message,
 * take both. An older core reads only indexes from 0 and never sees them.
 */
function slotOf(partIndex: number, size: DisplaySize): number {
  return size === 'large' ? partIndex : -2 - partIndex;
}

/**
 * The copy of a picture the timeline draws: WebP, its longer side at most
 * `DISPLAY_IMAGE_MAX` at quality 80, or `DISPLAY_THUMB_MAX` at quality 75 for
 * a thumbnail. Measured on 2026-10-07, 1.5 to 2.5 MB PNG screenshots became
 * 50 to 130 KB at the large size. `source` is the original as base64 or the
 * bytes of a larger copy. Null when Bun cannot decode it or refuses its size;
 * AVIF would be smaller still, but Bun's Linux build cannot encode it.
 */
export async function makeDisplay(source: string | Uint8Array, size: DisplaySize = 'large'): Promise<Uint8Array | null> {
  if (typeof Bun.Image !== 'function') return null;
  const { max, quality } = DISPLAY_SIZES[size];
  try {
    return await new Bun.Image(typeof source === 'string' ? Buffer.from(source, 'base64') : source, { maxPixels: PREVIEW_MAX_PIXELS })
      .resize(max, max, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality })
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
  private readonly displays = new Map<string, Promise<{ data: Uint8Array; kept: boolean }>>();
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
   * A WebP copy for `messages.attachment` with `display`, made once and kept
   * in `media_displays`. `source` is the original as base64 or the bytes of
   * the large copy, which a thumbnail is made from when it is kept. The
   * answer is the copy's bytes, or empty when the source is what to send: a
   * picture Bun cannot convert, or one whose copy would not be lighter.
   * `kept` is false when the journal could not keep it (a full disk, a
   * message that left its thread): only these bytes hold it then.
   */
  async display(threadId: string, messageId: string, partIndex: number, size: DisplaySize, source: string | Uint8Array): Promise<{ data: Uint8Array; kept: boolean }> {
    const kept = this.kept(threadId, messageId, partIndex, size);
    if (kept !== null) return { data: kept, kept: true };
    const key = `${messageId}\0${partIndex}\0${size}`;
    let made = this.displays.get(key);
    if (made === undefined) {
      const sourceBytes = typeof source === 'string' ? source.length * 3 / 4 : source.length;
      made = this.displayTurn(() => makeDisplay(source, size)).then(copy => {
        // The source wins when it is already as light: a small PNG icon, a WebP sent as one.
        const light = copy !== null && copy.length < sourceBytes ? copy : new Uint8Array(0);
        let kept = false;
        try {
          if (!this.core.journal.isClosed()) {
            putMediaDisplay(this.core.journal.db, threadId, messageId, slotOf(partIndex, size), light);
            // Nothing is written for a message that left its thread meanwhile.
            kept = this.core.journal.db.query('SELECT 1 FROM media_displays WHERE message_id = ? AND part_index = ? AND thread_id = ?')
              .get(messageId, slotOf(partIndex, size), threadId) !== null;
          }
        } catch (error) {
          this.core.log('warn', `${size} copy of message ${messageId} part ${partIndex} was not kept: ${messageOf(error)}`);
        }
        return { data: light, kept };
      }).finally(() => this.displays.delete(key));
      this.displays.set(key, made);
    }
    return await made;
  }

  /**
   * The copy `display` already kept, read without the original: empty when
   * its source is what to send, null when none was made. Only a copy of a
   * message of `threadId` is found, so a hit needs no other check.
   */
  kept(threadId: string, messageId: string, partIndex: number, size: DisplaySize): Uint8Array | null {
    try {
      return mediaDisplay(this.core.journal.db, threadId, messageId, slotOf(partIndex, size));
    } catch (error) {
      this.core.log('warn', `${size} copy of message ${messageId} part ${partIndex} could not be read: ${messageOf(error)}`);
      return null;
    }
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

  /** Queue a missing blur; a full queue leaves it for a later read. */
  private enqueue(threadId: string, messageId: string, partIndex: number, data: string): void {
    const key = `${messageId}\0${partIndex}`;
    const existing = this.waiting.get(key) ?? this.running.get(key);
    if (existing !== undefined) return;
    if (this.queuedChars + data.length > PREVIEW_QUEUE_CHARS && this.waiting.size + this.running.size > 0) return;
    this.queuedChars += data.length;
    this.waiting.set(key, { threadId, messageId, partIndex, data });
    this.pump();
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
        this.pump();
      });
    }
  }
}
