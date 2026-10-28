import { untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { imageSize, type Attachment } from '@boite/contracts';
import { attachmentSource } from './attachments';
import { isLoading } from './draft-attachments';

/**
 * The size a composer tile's thumbnail is made at, twice the 56 by 42 tile so
 * a 2x screen draws it sharp. The tile used to draw the attachment itself as a
 * `data:` URL: a 2,000 px screenshot decoded whole, about 9 MB, for 56 px,
 * and a new multi-megabyte string on each render of the strip.
 */
export const THUMB_WIDTH = 112;
export const THUMB_HEIGHT = 84;

function bytesOf(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function canMakeUrls(): boolean {
  return typeof URL.createObjectURL === 'function' && typeof URL.revokeObjectURL === 'function';
}

async function decode(blob: Blob, width: number, height: number): Promise<ImageBitmap> {
  try {
    // The decoder scales on the way, where the browser takes the size.
    return await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' });
  } catch {
    return await createImageBitmap(blob);
  }
}

/**
 * A small WebP (a PNG where the browser cannot write WebP) of `data` that
 * covers `width` by `height`, its proportions kept; null when the browser
 * cannot decode or draw it, and the tile falls back to the picture itself.
 * `source` is the file `data` was read from, when this device has it: its
 * bytes need no decoding from base64 on the main thread.
 */
export async function makeThumbnail(data: string, mimeType: string, width = THUMB_WIDTH, height = THUMB_HEIGHT, source?: Blob): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function') return null;
  const size = imageSize(data);
  let bitmap: ImageBitmap | null = null;
  try {
    const blob = source ?? new Blob([bytesOf(data)], { type: mimeType });
    const scale = size ? Math.min(1, Math.max(width / size.width, height / size.height)) : 1;
    const target = size ? { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) } : null;
    bitmap = target ? await decode(blob, target.width, target.height) : await createImageBitmap(blob);
    const fit = Math.min(1, Math.max(width / bitmap.width, height / bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * fit)), h = Math.max(1, Math.round(bitmap.height * fit));
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(w, h);
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, w, h);
      return await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, w, h);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8));
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

interface Preview {
  /** The thumbnail's object URL; null while it is made or when it could not be. */
  thumb: string | null;
  /** The whole picture's object URL, made when the preview first shows it. */
  full: string | null;
  failed: boolean;
}

/**
 * The pictures of a composer's attachments as object URLs: a thumbnail made
 * once per attachment for its tile, and the whole picture for the enlarged
 * preview. Each URL is revoked when its attachment leaves the prompt, or with
 * the strip. The bytes sent with the prompt never change. Without object URLs
 * (a test page), both fall back to the `data:` URL.
 */
export class AttachmentPreviews {
  #previews = new SvelteMap<Attachment, Preview>();
  #closed = false;

  /** Keeps a preview for each picture of `attachments` and lets go of the rest. */
  sync(attachments: readonly Attachment[]): void {
    untrack(() => this.#sync(attachments));
  }

  #sync(attachments: readonly Attachment[]): void {
    const present = new Set(attachments);
    for (const [attachment, preview] of this.#previews) {
      if (present.has(attachment)) continue;
      this.#revoke(preview);
      this.#previews.delete(attachment);
    }
    if (!canMakeUrls()) return;
    for (const attachment of attachments) {
      if (attachment.kind !== 'image' || isLoading(attachment) || this.#previews.has(attachment)) continue;
      const preview: Preview = { thumb: null, full: null, failed: false };
      this.#previews.set(attachment, preview);
      void makeThumbnail(attachment.data, attachment.mimeType, THUMB_WIDTH, THUMB_HEIGHT, attachmentSource(attachment)).then((thumbnail) => {
        if (this.#closed || this.#previews.get(attachment) !== preview) return;
        this.#previews.set(attachment, thumbnail
          ? { ...preview, thumb: URL.createObjectURL(thumbnail) }
          : { ...preview, failed: true });
      });
    }
  }

  /** What the tile draws: the thumbnail, the whole picture while none could be made, or nothing yet. */
  thumb(attachment: Attachment): string | null {
    const preview = this.#previews.get(attachment);
    if (!preview) return canMakeUrls() ? null : dataUrl(attachment);
    return preview.thumb ?? (preview.failed ? this.full(attachment) : null);
  }

  /** What the enlarged preview draws. */
  full(attachment: Attachment): string {
    const preview = this.#previews.get(attachment);
    if (!preview || !canMakeUrls()) return dataUrl(attachment);
    if (preview.full) return preview.full;
    // Made outside the render's reactive reads: the map is written back once, on its own.
    preview.full = URL.createObjectURL(attachmentSource(attachment) ?? new Blob([bytesOf(attachment.data)], { type: attachment.mimeType }));
    return preview.full;
  }

  /** Revokes every URL: the strip is gone. */
  close(): void {
    this.#closed = true;
    for (const preview of this.#previews.values()) this.#revoke(preview);
    this.#previews.clear();
  }

  #revoke(preview: Preview): void {
    if (preview.thumb) URL.revokeObjectURL(preview.thumb);
    if (preview.full) URL.revokeObjectURL(preview.full);
  }
}

function dataUrl(attachment: Attachment): string {
  return `data:${attachment.mimeType};base64,${attachment.data}`;
}
