import { expect, test } from 'vitest';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_TURN, type ImageAttachment } from '@boite/contracts';
import { acceptAttachments, decodedBytes, readAttachmentFile, stripDataPrefix } from './attachments';

/** One transparent pixel, the smallest real PNG. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function image(name: string | null, over: Partial<ImageAttachment> = {}): ImageAttachment {
  return { kind: 'image', mimeType: 'image/png', data: PIXEL, name, ...over };
}

test('a file arrives as base64 with the data: prefix stripped', async () => {
  const bytes = Uint8Array.from(atob(PIXEL), (character) => character.charCodeAt(0));
  const attachment = await readAttachmentFile(new File([bytes], 'pixel.png', { type: 'image/png' }));

  expect(attachment).toEqual({ kind: 'image', mimeType: 'image/png', data: PIXEL, name: 'pixel.png' });
  expect(attachment.data.startsWith('data:')).toBe(false);
  expect(decodedBytes(attachment.data)).toBe(bytes.length);
  // The helper leaves a body that never had a prefix alone.
  expect(stripDataPrefix(PIXEL)).toBe(PIXEL);
});

test('the count cap keeps what fits and names the one left out', () => {
  const current = Array.from({ length: ATTACHMENTS_PER_TURN - 1 }, (_, at) => image(`kept-${at}.png`));
  const { accepted, refused } = acceptAttachments(current, [image('last.png'), image('over.png')]);

  expect(accepted).toHaveLength(ATTACHMENTS_PER_TURN);
  expect(accepted.at(-1)?.name).toBe('last.png');
  expect(refused).toBe(`A turn carries at most ${ATTACHMENTS_PER_TURN} files, so over.png was left out.`);
});

test('an image over the size cap is refused by weight, the ones under it still land', () => {
  const over = Math.ceil(((ATTACHMENT_MAX_BYTES + 1) * 4) / 3);
  const big = image('huge.png', { data: 'A'.repeat(over) });
  expect(decodedBytes(big.data)).toBeGreaterThan(ATTACHMENT_MAX_BYTES);

  const { accepted, refused } = acceptAttachments([], [big, image('small.png')]);
  expect(accepted.map((one) => one.name)).toEqual(['small.png']);
  expect(refused).toBe('huge.png is too big: a file may weigh 5 MB at most.');
});

test('a format no agent reads is refused by name, and an unnamed paste still has a subject', () => {
  const { accepted, refused } = acceptAttachments([], [image(null, { mimeType: 'image/bmp' as never })]);

  expect(accepted).toEqual([]);
  expect(refused).toBe(
    'the attachment is image/bmp, and an image must be one of image/png, image/jpeg, image/gif, image/webp.'
  );
});


test('documents, unknown extensions and empty files use file attachments', async () => {
  for (const [name, type, content] of [['report.pdf', 'application/pdf', '%PDF-test'], ['script.ts', '', 'export {}'], ['empty.txt', 'text/plain', ''], ['vector.svg', 'image/svg+xml', '<svg/>']]) {
    const attachment = await readAttachmentFile(new File([content!], name!, { type }));
    expect(attachment.kind).toBe('file');
    expect(attachment.mimeType).toBe(type || 'application/octet-stream');
    expect(atob(attachment.data)).toBe(content);
    expect(acceptAttachments([], [attachment]).accepted).toEqual([attachment]);
  }
});
