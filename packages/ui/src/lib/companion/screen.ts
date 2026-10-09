/*
 * What is on the user's screen, for a request that needs it: the shell
 * captures the screen the companion is on, without the companion
 * (`companion_capture`), and the page makes a JPEG of it to attach to the turn.
 */
import type { ImageAttachment } from '@boite/contracts';
import { captureScreen } from './shell';

/** Below the core's attachment limit, in decoded bytes. */
const MAX_BYTES = 4_500_000;

/**
 * A request that speaks of the screen: the companion offers to look at it.
 * Whole words only; the word before is matched rather than looked behind,
 * which Safari 15.4 cannot do (docs/phone.md).
 */
const SCREEN_WORDS = /(?:^|[^\p{L}\p{N}])(screens?|screenshot|what i see|what i'm looking at|this window|écrans?|ecrans?|ce que je vois|cette fenêtre|cette fenetre)(?![\p{L}\p{N}])/iu;

export const mentionsScreen = (text: string): boolean => SCREEN_WORDS.test(text);

/** The screen as an image attachment; null outside the shell or when the capture failed. */
export async function screenAttachment(): Promise<ImageAttachment | null> {
  const buffer = await captureScreen();
  if (!buffer || buffer.byteLength < 8) return null;
  const header = new DataView(buffer, 0, 8);
  const [width, height] = [header.getUint32(0, true), header.getUint32(4, true)];
  if (width === 0 || height === 0 || buffer.byteLength < 8 + width * height * 4) return null;
  const pixels = new Uint8ClampedArray(buffer, 8, width * height * 4);
  // Windows hands BGRA with no alpha to speak of: RGBA, opaque.
  for (let index = 0; index < pixels.length; index += 4) {
    const blue = pixels[index]!;
    pixels[index] = pixels[index + 2]!;
    pixels[index + 2] = blue;
    pixels[index + 3] = 255;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.putImageData(new ImageData(pixels, width, height), 0, 0);
  for (const quality of [0.82, 0.6, 0.4]) {
    const data = canvas.toDataURL('image/jpeg', quality).replace(/^data:image\/jpeg;base64,/, '');
    if ((data.length * 3) / 4 <= MAX_BYTES) return { kind: 'image', mimeType: 'image/jpeg', data, name: 'screen.jpg' };
  }
  return null;
}
