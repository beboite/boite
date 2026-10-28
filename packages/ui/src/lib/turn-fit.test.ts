import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ATTACHMENTS_TOTAL_MAX_BYTES, IMAGE_MAX_EDGE, decodedBytes, type Attachment } from '@boite/contracts';
import { attachFiles, gatherAttachments } from './composer-attachments';
import type { Store } from './store.svelte';
import { FIT_FLOOR_EDGE, fitHeld, fitTurn, waterLevel } from './turn-fit';
import type { ImageCodec } from './image-prepare';
import { startBunCodec, type BunCodec } from '../test/bun-codec';
import { screenshot } from '../test/screenshots';

const KB = 1024;
/** A tenth of the real budget, with pictures a tenth as heavy: the same shares at a tenth of the bytes to copy. */
const MAX = ATTACHMENTS_TOTAL_MAX_BYTES / 10;

/** A JPEG attachment of `size` decoded bytes. */
function jpeg(name: string, size: number): Attachment {
  return { kind: 'image', mimeType: 'image/jpeg', name, data: Buffer.alloc(size).toString('base64') };
}

/** Every encoding weighs what its edge and quality say: 2000 px at 0.75 is `full`, smaller as either falls. */
function weighingCodec(full: number, encoded: { width: number; height: number; quality?: number }[] = []): ImageCodec {
  return {
    async decode() {
      return {
        width: 924,
        height: 2000,
        hasAlpha: () => false,
        async encode(width, height, mimeType, quality) {
          encoded.push({ width, height, quality });
          const size = Math.round(full * ((width * height) / (924 * 2000)) * ((quality ?? 0.75) / 0.75));
          return new Blob([new Uint8Array(size)], { type: mimeType });
        },
        close() {}
      };
    }
  };
}

describe('the share', () => {
  test('images under the level keep their weight, the rest share what is left', () => {
    expect(waterLevel([100, 100, 1000, 1000], 1000)).toBe(400);
    expect(waterLevel([100, 200], 1000)).toBe(Infinity);
    expect(waterLevel([500], 0)).toBe(0);
  });
});

describe('fitTurn', () => {
  test('a turn under budget comes back untouched, the same array', async () => {
    const turn = [jpeg('a.jpg', 400 * KB), jpeg('b.jpg', 400 * KB)];
    const encoded: unknown[] = [];
    const fitted = await fitTurn(turn, weighingCodec(400 * KB, encoded as never));
    expect(fitted).toEqual({ attachments: turn, fits: true });
    expect(encoded).toEqual([]);
  });

  test('over budget, the light images, the GIF and the files stay; the heavy ones come under their share', async () => {
    const gif: Attachment = { kind: 'image', mimeType: 'image/gif', name: 'loop.gif', data: Buffer.alloc(80 * KB).toString('base64') };
    const pdf: Attachment = { kind: 'file', mimeType: 'application/pdf', name: 'spec.pdf', data: Buffer.alloc(20 * KB).toString('base64') };
    const small = jpeg('small.jpg', 5 * KB);
    const heavy = Array.from({ length: 40 }, (_, at) => jpeg(`shot-${at}.jpg`, 52 * KB));
    const turn = [gif, pdf, small, ...heavy];
    const fitted = await fitTurn(turn, weighingCodec(52 * KB), MAX);
    expect(fitted.fits).toBe(true);
    expect(fitted.attachments.slice(0, 3)).toEqual([gif, pdf, small]);
    const total = fitted.attachments.reduce((sum, one) => sum + decodedBytes(one.data), 0);
    expect(total).toBeLessThanOrEqual(MAX);
    expect(fitted.attachments.slice(3).every(one => one.kind === 'image' && one.mimeType === 'image/jpeg' && one.name?.endsWith('.jpg'))).toBe(true);
  });

  test('never under the floor: past it the turn says it does not fit', async () => {
    const encoded: { width: number; height: number }[] = [];
    const turn = Array.from({ length: 50 }, (_, at) => jpeg(`shot-${at}.jpg`, 512 * KB));
    const fitted = await fitTurn(turn, weighingCodec(512 * KB, encoded), MAX);
    expect(fitted.fits).toBe(false);
    expect(Math.min(...encoded.map(one => Math.max(one.width, one.height)))).toBe(FIT_FLOOR_EDGE);
  });

  test('two fits of one box at once end within the budget, and say so only when the box fits', async () => {
    const box = { attachments: Array.from({ length: 15 }, (_, at) => jpeg(`first-${at}.jpg`, 90 * KB)) };
    const first = fitHeld(box, weighingCodec(90 * KB), MAX);
    // More pictures join while the first fit runs, and start their own.
    box.attachments = [...box.attachments, ...Array.from({ length: 15 }, (_, at) => jpeg(`second-${at}.jpg`, 90 * KB))];
    const second = fitHeld(box, weighingCodec(90 * KB), MAX);
    const answers = await Promise.all([first, second]);
    const total = box.attachments.reduce((sum, one) => sum + decodedBytes(one.data), 0);
    expect(box.attachments).toHaveLength(30);
    expect(total).toBeLessThanOrEqual(MAX);
    expect(answers).toEqual([true, true]);
  });

  test('a picture removed while the box was fitted stays removed', async () => {
    const box = { attachments: Array.from({ length: 30 }, (_, at) => jpeg(`shot-${at}.jpg`, 52 * KB)) };
    const removed = box.attachments[0]!;
    const fitting = fitHeld(box, weighingCodec(52 * KB), MAX);
    box.attachments = box.attachments.slice(1);
    expect(await fitting).toBe(true);
    expect(box.attachments).toHaveLength(29);
    expect(box.attachments).not.toContain(removed);
  });

  test('a file picked while the box is fitted waits for that fit, then the pictures make room for it', async () => {
    const slow = (codec: ImageCodec, delay: number): ImageCodec => ({
      async decode(file) {
        const image = (await codec.decode(file))!;
        return { ...image, async encode(...args) { await new Promise(resolve => setTimeout(resolve, delay)); return image.encode(...args); } };
      }
    });
    const box = { attachments: Array.from({ length: 3 }, (_, at) => jpeg(`shot-${at}.jpg`, 4 * 1024 * KB)) };
    void fitHeld(box, slow(weighingCodec(4 * 1024 * KB), 2));
    // The composer hands the files a stand-in that keeps undo steps; the box is what its fits run on.
    const holder = { get attachments() { return box.attachments; }, set attachments(value: Attachment[]) { box.attachments = value; }, box };
    const store = { error: null } as unknown as Store;
    const pdf = new File([new Uint8Array(4 * 1024 * KB)], 'spec.pdf', { type: 'application/pdf' });
    await attachFiles(store, [pdf], holder, null, undefined, slow(weighingCodec(4 * 1024 * KB), 5));
    expect(store.error).toBeNull();
    expect(box.attachments.map(one => one.name)).toEqual(['shot-0.jpg', 'shot-1.jpg', 'shot-2.jpg', 'spec.pdf']);
    expect(box.attachments.reduce((sum, one) => sum + decodedBytes(one.data), 0)).toBeLessThanOrEqual(ATTACHMENTS_TOTAL_MAX_BYTES);
  });

  test('a picture pasted while waiting files are fitted is fitted with them', async () => {
    const box = { attachments: Array.from({ length: 2 }, (_, at) => jpeg(`shot-${at}.jpg`, 4 * 1024 * KB)) };
    const weighing = weighingCodec(4 * 1024 * KB);
    let pasted = false;
    // A paste lands in the box as the first picture is encoded, outside the box's queue.
    const codec: ImageCodec = {
      async decode(file) {
        const image = (await weighing.decode(file))!;
        return { ...image, async encode(...args) {
          if (!pasted) { pasted = true; box.attachments = [...box.attachments, jpeg('pasted.jpg', 4 * 1024 * KB)]; }
          return image.encode(...args);
        } };
      }
    };
    const store = { error: null } as unknown as Store;
    const pdf = new File([new Uint8Array(4 * 1024 * KB)], 'spec.pdf', { type: 'application/pdf' });
    await attachFiles(store, [pdf], box, null, undefined, codec);
    expect(store.error).toBeNull();
    expect(box.attachments.map(one => one.name)).toEqual(['shot-0.jpg', 'shot-1.jpg', 'pasted.jpg', 'spec.pdf']);
    expect(box.attachments.reduce((sum, one) => sum + decodedBytes(one.data), 0)).toBeLessThanOrEqual(ATTACHMENTS_TOTAL_MAX_BYTES);
  });
});

/**
 * Fifty real screenshots, phone and desktop PNGs of 3 to 5 MB, through the
 * composer's path with Bun's real encoders: twenty was the cap, and fifty
 * prepared ones weigh about 26 MB, over the 10 MB a turn carries.
 */
describe('fifty screenshots in one turn', () => {
  let bun: BunCodec;
  beforeAll(() => { bun = startBunCodec(); });
  afterAll(() => bun.close());

  test('all fifty go in, under 10 MB, each between the floor and 2000 px', async () => {
    const files = Array.from({ length: 50 }, (_, at) => {
      const phone = at % 2 === 0;
      const png = phone ? screenshot(1170, 2532, at + 1) : screenshot(2560, 1440, at + 1);
      return new File([png], `${phone ? 'IMG' : 'Screenshot'}_${at}.png`, { type: 'image/png' });
    });
    const sources = files.map(file => file.size);
    expect(Math.min(...sources)).toBeGreaterThan(2 * 1024 * KB);

    let held: Attachment[] = [];
    const refused = await gatherAttachments(files, {
      held: () => held,
      add: (one) => { held = [...held, one]; },
      replace: (lighter) => { held = held.map(one => lighter.get(one) ?? one); },
      noImages: null,
      codec: bun.codec
    });

    expect(refused).toBeNull();
    expect(held).toHaveLength(50);
    const sizes = held.map(one => decodedBytes(one.data));
    const total = sizes.reduce((sum, size) => sum + size, 0);
    expect(total).toBeLessThanOrEqual(ATTACHMENTS_TOTAL_MAX_BYTES);
    const edges = await Promise.all(held.map(async (one) => {
      const decoded = (await bun.codec.decode(new File([Buffer.from(one.data, 'base64')], one.name ?? '', { type: one.mimeType })))!;
      return Math.max(decoded.width, decoded.height);
    }));
    expect(Math.min(...edges)).toBeGreaterThanOrEqual(FIT_FLOOR_EDGE);
    expect(Math.max(...edges)).toBeLessThanOrEqual(IMAGE_MAX_EDGE);
    // BOITE_FIT_REPORT=<file> writes what was measured, for a report.
    if (process.env.BOITE_FIT_REPORT) writeFileSync(process.env.BOITE_FIT_REPORT, JSON.stringify({ sources, sizes, edges, total }));
  }, 300_000);
});
