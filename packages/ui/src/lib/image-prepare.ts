/**
 * A photo or a screenshot made light enough to send. A phone screenshot is a
 * 2 to 4 MB PNG and a photo a 12 MP HEIC: neither is something an agent needs
 * at full size, and the core caps a turn at `ATTACHMENTS_TOTAL_MAX_BYTES`. So
 * an image is brought to `IMAGE_MAX_EDGE` pixels on its long edge and encoded
 * as JPEG, or as PNG when it is smaller or its transparency matters; one that
 * is already small enough goes as it is. HEIC becomes JPEG wherever the
 * browser decodes it (Safari does); elsewhere it stays a plain file.
 *
 * The decisions are pure functions; the canvas work is behind `ImageCodec` so
 * a test can drive the whole path without a browser.
 */
import { ATTACHMENT_MAX_BYTES, IMAGE_MAX_EDGE, IMAGE_MIME_TYPES } from '@boite/contracts';

/** The long edge an image is brought to: past it Claude refuses a request carrying many images. */
export { IMAGE_MAX_EDGE };
export const JPEG_QUALITY = 0.85;
/** Over this an image is not even decoded: a phone's canvas would not hold it. */
export const IMAGE_SOURCE_MAX_BYTES = 50 * 1024 * 1024;
/** Under this, an image already within `IMAGE_MAX_EDGE` in a format agents read goes untouched. */
export const IMAGE_KEEP_BYTES = 512 * 1024;

const HEIC_TYPES = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'];
const HEIC_NAME = /\.(heic|heif)$/i;

export function isHeic(file: { type: string; name: string }): boolean {
  if (HEIC_TYPES.includes(file.type.toLowerCase())) return true;
  return (file.type === '' || file.type === 'application/octet-stream') && HEIC_NAME.test(file.name);
}

/**
 * Worth decoding to reduce: a raster image. A GIF keeps its frames as it is
 * and an SVG is text, so both go untouched.
 */
export function isReducible(file: { type: string; name: string }): boolean {
  if (isHeic(file)) return true;
  const type = file.type.toLowerCase();
  return type.startsWith('image/') && type !== 'image/gif' && type !== 'image/svg+xml';
}

/** The size that fits `max` on the long edge, never larger than the source. */
export function fitWithin(width: number, height: number, max = IMAGE_MAX_EDGE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max || long === 0) return { width, height };
  const scale = max / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The name with the extension of what it became: `IMG_0042.HEIC` sent as JPEG is `IMG_0042.jpg`. */
export function renamed(name: string, mimeType: string): string {
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name || 'image';
  return `${stem}.${extension}`;
}

export interface Encoded {
  blob: Blob;
  mimeType: 'image/jpeg' | 'image/png';
}

/** A decoded image, ready to be drawn at a size. */
export interface Decoded {
  width: number;
  height: number;
  /** Does any pixel let the background through? Only asked of formats that can. */
  hasAlpha(): boolean;
  encode(width: number, height: number, mimeType: Encoded['mimeType'], quality?: number): Promise<Blob | null>;
  close(): void;
}

export interface ImageCodec {
  /** Null when this browser cannot decode the file (HEIC outside Safari, a broken file). */
  decode(file: File): Promise<Decoded | null>;
}

export type Prepared =
  | { kind: 'kept'; file: File }
  | { kind: 'reduced'; file: File }
  /** The browser could not decode it: it travels as a file, HEIC included. */
  | { kind: 'undecodable'; file: File }
  | { kind: 'tooLarge'; file: File };

const KEEPABLE = IMAGE_MIME_TYPES as readonly string[];

/**
 * Which of the encodings to send. The original stays a candidate when it is
 * in a format agents read and within the size: re-encoding a small PNG
 * screenshot can make it heavier. Ties go to the earlier candidate.
 */
export function smallest<T extends { size: number }>(candidates: (T | null)[]): T | null {
  let best: T | null = null;
  for (const candidate of candidates) if (candidate !== null && (best === null || candidate.size < best.size)) best = candidate;
  return best;
}

export async function prepareImage(file: File, codec: ImageCodec = browserCodec): Promise<Prepared> {
  if (!isReducible(file)) return { kind: 'kept', file };
  if (file.size > IMAGE_SOURCE_MAX_BYTES) return { kind: 'tooLarge', file };
  const keepable = KEEPABLE.includes(file.type) && !isHeic(file);
  let decoded: Decoded | null = null;
  try { decoded = await codec.decode(file); } catch { decoded = null; }
  if (decoded === null) return { kind: keepable ? 'kept' : 'undecodable', file };
  try {
    const target = fitWithin(decoded.width, decoded.height);
    const fits = target.width === decoded.width && target.height === decoded.height;
    if (keepable && fits && file.size <= IMAGE_KEEP_BYTES) return { kind: 'kept', file };
    // Transparency is worth keeping only where the format can carry it.
    const canAlpha = file.type === 'image/png' || file.type === 'image/webp';
    const alpha = canAlpha && decoded.hasAlpha();
    const png = canAlpha ? await decoded.encode(target.width, target.height, 'image/png') : null;
    // A transparent image goes as PNG unless that PNG is over what a file may weigh.
    const pngWill = alpha && png !== null && png.size <= ATTACHMENT_MAX_BYTES;
    const jpeg = pngWill ? null : await decoded.encode(target.width, target.height, 'image/jpeg', JPEG_QUALITY);
    const original = keepable && fits ? file : null;
    const pick = smallest<Blob>([original, png, jpeg]);
    if (pick === null || pick === file) return { kind: 'kept', file };
    const mimeType = pick === png ? 'image/png' : 'image/jpeg';
    return {
      kind: 'reduced',
      file: new File([pick], renamed(file.name, mimeType), { type: mimeType, lastModified: file.lastModified })
    };
  } finally {
    decoded.close();
  }
}

/**
 * Decoding, resizing and encoding off the main thread, so a pasted screenshot
 * never stops the typing: a 4K PNG held the page for about 200 ms on the
 * server (2026-10-28, in `toBlob` and `getImageData`), longer on a slower PC.
 * The worker decodes with `createImageBitmap` and draws on an
 * `OffscreenCanvas`; what it cannot decode (HEIC, which only Safari's image
 * element reads, or a browser without those APIs) runs here through
 * `browserCodec`. A given codec runs here too: the tests drive it.
 */
export function prepareImageAway(file: File, codec?: ImageCodec): Promise<Prepared> {
  if (codec || !isReducible(file) || isHeic(file)) return prepareImage(file, codec);
  const away = prepareWorker();
  if (!away) return prepareImage(file);
  return new Promise((resolve) => {
    const id = ++lastJob;
    jobs.set(id, (prepared) => { resolve(prepared ?? prepareImage(file)); });
    away.postMessage({ id, file });
  });
}

/** The worker, made for the first picture; null once it could not start, and every picture then runs here. */
let worker: Worker | null | undefined;
let lastJob = 0;
const jobs = new Map<number, (prepared: Prepared | null) => void>();

function prepareWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return worker = null;
  try {
    worker = new Worker(new URL('./image-prepare.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return worker = null;
  }
  worker.onmessage = ({ data }: MessageEvent<{ id: number; prepared: Prepared | null }>) => {
    const done = jobs.get(data.id);
    jobs.delete(data.id);
    done?.(data.prepared);
  };
  // A worker that failed to load answers nothing: what it was given runs here.
  worker.onerror = (event) => {
    event.preventDefault();
    worker?.terminate();
    worker = null;
    const waiting = [...jobs.values()];
    jobs.clear();
    for (const done of waiting) done(null);
  };
  return worker;
}

/** The worker's decoders. Null for a file only the page's image element might read. */
export const offscreenCodec: ImageCodec = {
  async decode(file) {
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') return null;
    let bitmap: ImageBitmap;
    try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch {
      try { bitmap = await createImageBitmap(file); } catch { return null; }
    }
    const { width, height } = bitmap;
    let alphaChecked: boolean | null = null;
    return {
      width,
      height,
      hasAlpha() {
        if (alphaChecked !== null) return alphaChecked;
        const probe = fitWithin(width, height, 256);
        const context = new OffscreenCanvas(probe.width, probe.height).getContext('2d', { willReadFrequently: true });
        if (!context) return (alphaChecked = false);
        context.drawImage(bitmap, 0, 0, probe.width, probe.height);
        const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
        alphaChecked = false;
        for (let at = 3; at < pixels.length; at += 4) if (pixels[at]! < 255) { alphaChecked = true; break; }
        return alphaChecked;
      },
      async encode(targetWidth, targetHeight, mimeType, quality) {
        const canvas = new OffscreenCanvas(targetWidth, targetHeight);
        const context = canvas.getContext('2d');
        if (!context) return null;
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        if (mimeType === 'image/jpeg') {
          context.fillStyle = 'white';
          context.fillRect(0, 0, targetWidth, targetHeight);
        }
        context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
        try {
          const blob = await canvas.convertToBlob({ type: mimeType, quality });
          return blob.type === mimeType ? blob : null;
        } catch { return null; }
      },
      close: () => bitmap.close()
    };
  }
};

/**
 * The browser's decoders. `<img>` first: it is what decodes HEIC in Safari
 * and it applies the EXIF orientation; `createImageBitmap` where the image
 * element fails. The canvas draws on white, so a JPEG of a transparent image
 * reads as it did on the page.
 */
export const browserCodec: ImageCodec = {
  async decode(file) {
    // No 2D canvas (a test DOM, a locked-down browser): the image goes as it is.
    if (typeof document === 'undefined' || document.createElement('canvas').getContext('2d') === null) return null;
    const source = (await viaImageElement(file)) ?? (await viaBitmap(file));
    if (source === null) return null;
    const { image, width, height, release } = source;
    let alphaChecked: boolean | null = null;
    return {
      width,
      height,
      hasAlpha() {
        if (alphaChecked !== null) return alphaChecked;
        // A small copy says as much about transparency as the full one.
        const probe = fitWithin(width, height, 256);
        const canvas = document.createElement('canvas');
        canvas.width = probe.width;
        canvas.height = probe.height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return (alphaChecked = false);
        context.drawImage(image, 0, 0, probe.width, probe.height);
        const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
        alphaChecked = false;
        for (let at = 3; at < pixels.length; at += 4) if (pixels[at]! < 255) { alphaChecked = true; break; }
        return alphaChecked;
      },
      encode(targetWidth, targetHeight, mimeType, quality) {
        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const context = canvas.getContext('2d');
        if (!context) return Promise.resolve(null);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        if (mimeType === 'image/jpeg') {
          context.fillStyle = 'white';
          context.fillRect(0, 0, targetWidth, targetHeight);
        }
        context.drawImage(image, 0, 0, targetWidth, targetHeight);
        return new Promise((resolve) => {
          canvas.toBlob((blob) => {
            // iOS frees a canvas only once its size is zero.
            canvas.width = 0;
            canvas.height = 0;
            resolve(blob && blob.type === mimeType ? blob : null);
          }, mimeType, quality);
        });
      },
      close: release
    };
  }
};

type Source = { image: CanvasImageSource; width: number; height: number; release: () => void };

async function viaImageElement(file: File): Promise<Source | null> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = 'async';
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('undecodable'));
      image.src = url;
    });
    if (image.naturalWidth === 0 || image.naturalHeight === 0) throw new Error('empty');
    return { image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

async function viaBitmap(file: File): Promise<Source | null> {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const bitmap = await createImageBitmap(file);
    return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  } catch {
    return null;
  }
}
