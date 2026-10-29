import { IMAGE_MAX_EDGE, type ImageAttachment } from '@boite/contracts';

/** What Bun re-encodes in its own format. A GIF keeps its frames by going as it is. */
const RESIZABLE = /^image\/(png|jpeg|webp)$/;
/** Past this many pixels an image is not decoded: one 8K screenshot is already 33 million. */
const SOURCE_MAX_PIXELS = 7680 * 4320;

/**
 * An image brought within `IMAGE_MAX_EDGE` on its long edge before it goes to
 * Claude, in its own format. The composer already does it, but an image can
 * reach a prompt without passing there: one a client sent unprepared, one
 * whose decoding failed in the browser, or one replayed from a message
 * written when the cap was 2048 px (a retry, a carried-over history). The CLI
 * forwards a prompt's images as they are, and one over 2000 px fails every
 * request of the conversation once it holds more than 20 images. The images
 * the CLI's own tools read are its business: it fits them to the model.
 * Anything Bun cannot read goes as it is.
 */
export async function fitImage(attachment: ImageAttachment): Promise<ImageAttachment> {
  if (!RESIZABLE.test(attachment.mimeType) || typeof Bun.Image !== 'function') return attachment;
  try {
    const source = Buffer.from(attachment.data, 'base64');
    const { width, height } = await new Bun.Image(source, { maxPixels: SOURCE_MAX_PIXELS }).metadata();
    if (Math.max(width, height) <= IMAGE_MAX_EDGE) return attachment;
    const bytes = await new Bun.Image(source, { maxPixels: SOURCE_MAX_PIXELS })
      .resize(IMAGE_MAX_EDGE, IMAGE_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .bytes();
    return { ...attachment, data: Buffer.from(bytes).toString('base64') };
  } catch {
    return attachment;
  }
}

/**
 * One image at a time: a turn takes fifty, and decoding them all at once at
 * the pixel cap would hold gigabytes. Most are within the edge and cost only
 * a header read.
 */
export async function fitImages(attachments: readonly ImageAttachment[]): Promise<ImageAttachment[]> {
  const fitted: ImageAttachment[] = [];
  for (const attachment of attachments) fitted.push(await fitImage(attachment));
  return fitted;
}
