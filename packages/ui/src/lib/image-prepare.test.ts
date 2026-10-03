import { describe, expect, test } from 'vitest';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_TURN, type Attachment } from '@boite/contracts';
import { gatherAttachments } from './composer-attachments';
import {
  IMAGE_MAX_EDGE,
  IMAGE_SOURCE_MAX_BYTES,
  fitWithin,
  isHeic,
  isReducible,
  prepareImage,
  renamed,
  type Decoded,
  type ImageCodec
} from './image-prepare';

function file(name: string, type: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type });
}

/** A decoder that knows the sizes and says what each encoding would weigh. */
function codec(image: { width: number; height: number; alpha?: boolean } | null, weigh: Partial<Record<'image/jpeg' | 'image/png', number>> = {}) {
  const encoded: { width: number; height: number; mimeType: string; quality?: number }[] = [];
  let closed = 0;
  const codec: ImageCodec = {
    async decode() {
      if (image === null) return null;
      const decoded: Decoded = {
        width: image.width,
        height: image.height,
        hasAlpha: () => image.alpha === true,
        async encode(width, height, mimeType, quality) {
          encoded.push({ width, height, mimeType, quality });
          const size = weigh[mimeType];
          return size === undefined ? null : new Blob([new Uint8Array(size)], { type: mimeType });
        },
        close: () => { closed += 1; }
      };
      return decoded;
    }
  };
  return { codec, encoded, closed: () => closed };
}

describe('the decisions', () => {
  test('HEIC is an image by type or, typeless, by name', () => {
    expect(isHeic({ type: 'image/heic', name: 'a' })).toBe(true);
    expect(isHeic({ type: 'image/HEIF', name: 'a' })).toBe(true);
    expect(isHeic({ type: '', name: 'IMG_0042.HEIC' })).toBe(true);
    expect(isHeic({ type: 'application/octet-stream', name: 'x.heif' })).toBe(true);
    expect(isHeic({ type: 'image/jpeg', name: 'x.heic' })).toBe(false);
    expect(isReducible({ type: '', name: 'IMG_0042.HEIC' })).toBe(true);
  });

  test('a GIF keeps its frames and an SVG is text: neither is redrawn', () => {
    expect(isReducible({ type: 'image/gif', name: 'a.gif' })).toBe(false);
    expect(isReducible({ type: 'image/svg+xml', name: 'a.svg' })).toBe(false);
    expect(isReducible({ type: 'application/pdf', name: 'a.pdf' })).toBe(false);
    expect(isReducible({ type: 'image/avif', name: 'a.avif' })).toBe(true);
  });

  test('the long edge comes to 2048 and the ratio stays', () => {
    expect(fitWithin(1179, 2556)).toEqual({ width: 945, height: IMAGE_MAX_EDGE });
    expect(fitWithin(4032, 3024)).toEqual({ width: IMAGE_MAX_EDGE, height: 1536 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  test('the name follows the format it became', () => {
    expect(renamed('IMG_0042.HEIC', 'image/jpeg')).toBe('IMG_0042.jpg');
    expect(renamed('Screenshot 2026-10-03.png', 'image/jpeg')).toBe('Screenshot 2026-10-03.jpg');
    expect(renamed('image', 'image/png')).toBe('image.png');
    expect(renamed('', 'image/jpeg')).toBe('image.jpg');
  });
});

describe('prepareImage', () => {
  test('an iPhone screenshot comes to 2048 px as the lighter of JPEG and PNG', async () => {
    const shot = file('IMG_0001.PNG', 'image/png', 3_200_000);
    const fake = codec({ width: 1179, height: 2556 }, { 'image/jpeg': 420_000, 'image/png': 1_900_000 });
    const prepared = await prepareImage(shot, fake.codec);
    expect(prepared.kind).toBe('reduced');
    expect(prepared.file.type).toBe('image/jpeg');
    expect(prepared.file.name).toBe('IMG_0001.jpg');
    expect(prepared.file.size).toBe(420_000);
    expect(fake.encoded).toEqual([
      { width: 945, height: 2048, mimeType: 'image/png', quality: undefined },
      { width: 945, height: 2048, mimeType: 'image/jpeg', quality: 0.85 }
    ]);
    expect(fake.closed()).toBe(1);
  });

  test('a flat screenshot that is lighter as PNG stays PNG', async () => {
    const shot = file('chart.png', 'image/png', 3_000_000);
    const fake = codec({ width: 3000, height: 1000 }, { 'image/jpeg': 700_000, 'image/png': 300_000 });
    const prepared = await prepareImage(shot, fake.codec);
    expect(prepared.file.type).toBe('image/png');
    expect(prepared.file.name).toBe('chart.png');
  });

  test('transparency keeps PNG, unless that PNG is over the cap', async () => {
    const logo = file('logo.png', 'image/png', 9_000_000);
    const kept = await prepareImage(logo, codec({ width: 4000, height: 4000, alpha: true }, { 'image/png': 2_000_000, 'image/jpeg': 400_000 }).codec);
    expect(kept.file.type).toBe('image/png');
    const heavy = await prepareImage(logo, codec({ width: 4000, height: 4000, alpha: true }, { 'image/png': ATTACHMENT_MAX_BYTES + 1, 'image/jpeg': 400_000 }).codec);
    expect(heavy.file.type).toBe('image/jpeg');
  });

  test('a HEIC photo becomes JPEG where the browser decodes it', async () => {
    const photo = file('IMG_0042.HEIC', 'image/heic', 2_500_000);
    const fake = codec({ width: 4032, height: 3024 }, { 'image/jpeg': 900_000 });
    const prepared = await prepareImage(photo, fake.codec);
    expect(prepared).toMatchObject({ kind: 'reduced' });
    expect(prepared.file.type).toBe('image/jpeg');
    expect(prepared.file.name).toBe('IMG_0042.jpg');
    // A JPEG source cannot be transparent: no PNG is tried.
    expect(fake.encoded.map((one) => one.mimeType)).toEqual(['image/jpeg']);
  });

  test('a HEIC the browser cannot decode goes as a file', async () => {
    const photo = file('IMG_0042.HEIC', '', 2_500_000);
    const prepared = await prepareImage(photo, codec(null).codec);
    expect(prepared).toEqual({ kind: 'undecodable', file: photo });
  });

  test('a small image already within 2048 px goes untouched', async () => {
    const small = file('pixel.png', 'image/png', 40_000);
    const fake = codec({ width: 600, height: 400 }, { 'image/jpeg': 10, 'image/png': 10 });
    expect(await prepareImage(small, fake.codec)).toEqual({ kind: 'kept', file: small });
    expect(fake.encoded).toEqual([]);
  });

  test('an image within 2048 px that no encoding beats is sent as it is', async () => {
    const photo = file('photo.jpg', 'image/jpeg', 800_000);
    const prepared = await prepareImage(photo, codec({ width: 2000, height: 1500 }, { 'image/jpeg': 950_000 }).codec);
    expect(prepared).toEqual({ kind: 'kept', file: photo });
  });

  test('a source over 50 MB is refused before decoding', async () => {
    const huge = file('pano.jpg', 'image/jpeg', IMAGE_SOURCE_MAX_BYTES + 1);
    const fake = codec({ width: 20000, height: 4000 }, { 'image/jpeg': 1 });
    expect((await prepareImage(huge, fake.codec)).kind).toBe('tooLarge');
    expect(fake.encoded).toEqual([]);
  });

  test('a supported image the browser fails to decode still goes as it is', async () => {
    const photo = file('photo.jpg', 'image/jpeg', 2_000_000);
    expect(await prepareImage(photo, codec(null).codec)).toEqual({ kind: 'kept', file: photo });
  });
});

describe('gatherAttachments', () => {
  function holder(start: Attachment[] = [], noImages: { provider: string } | null = null, imageCodec?: ImageCodec) {
    let held = start;
    return {
      get list() { return held; },
      holder: { held: () => held, add: (one: Attachment) => { held = [...held, one]; }, noImages, codec: imageCodec }
    };
  }

  test('twenty reduced screenshots go in one turn, the twenty-first is refused by name', async () => {
    const fake = codec({ width: 1179, height: 2556 }, { 'image/jpeg': 400_000, 'image/png': 1_500_000 });
    const shots = Array.from({ length: ATTACHMENTS_PER_TURN + 1 }, (_, at) => file(`IMG_${at}.PNG`, 'image/png', 3_000_000));
    const target = holder([], null, fake.codec);
    const refused = await gatherAttachments(shots, target.holder);
    expect(target.list).toHaveLength(ATTACHMENTS_PER_TURN);
    expect(target.list.every((one) => one.kind === 'image' && one.mimeType === 'image/jpeg')).toBe(true);
    expect(refused).toBe(`A turn carries at most ${ATTACHMENTS_PER_TURN} files, so IMG_${ATTACHMENTS_PER_TURN}.PNG was left out.`);
  });

  test('a provider without images refuses them before any decoding, a PDF still goes', async () => {
    const fake = codec({ width: 100, height: 100 }, { 'image/jpeg': 10 });
    const target = holder([], { provider: 'Antigravity' }, fake.codec);
    const refused = await gatherAttachments([file('a.png', 'image/png', 10), file('notes.pdf', 'application/pdf', 10)], target.holder);
    expect(refused).toBe('Antigravity takes no images: send the prompt without them.');
    expect(target.list.map((one) => one.name)).toEqual(['notes.pdf']);
    expect(fake.encoded).toEqual([]);
  });

  test('a source over 50 MB says so, with its weight', async () => {
    const target = holder();
    const refused = await gatherAttachments([file('pano.jpg', 'image/jpeg', IMAGE_SOURCE_MAX_BYTES + 1)], target.holder);
    expect(refused).toContain('pano.jpg weighs');
    expect(target.list).toEqual([]);
  });

  test('an undecodable HEIC is attached as a file', async () => {
    const target = holder([], null, codec(null).codec);
    await gatherAttachments([file('IMG_0042.HEIC', 'image/heic', 1000)], target.holder);
    expect(target.list).toMatchObject([{ kind: 'file', mimeType: 'image/heic', name: 'IMG_0042.HEIC' }]);
  });
});
