/*
 * What is on the user's screens, for a request that needs it: the shell
 * captures a screen without the companion (`companion_capture`), every screen
 * one after the other, or the part the user picked, and the page makes JPEGs
 * of them to attach to the turn.
 */
import { ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES, type ImageAttachment } from '@boite/contracts';
import type { Seen } from './brain';
import { captureScreen, companionMonitors, type HitRect } from './shell';

/** Below the core's limit for one attachment, in decoded bytes. */
const MAX_BYTES = 4_500_000;
/** Below the core's limit for a turn's attachments together. */
const TOTAL_BYTES = ATTACHMENTS_TOTAL_MAX_BYTES - 500_000;

/** What the eye shows: every screen, the one the companion is on, or a part the user picks. */
export type ScreenScope = 'all' | 'here' | 'zone';

/** The images that go with a request, and what they show, for the prompt. */
export interface ScreenShot {
  images: ImageAttachment[];
  seen: Seen;
}

/**
 * A request that speaks of the screen: the companion offers to look at it.
 * Whole words only; the word before is matched rather than looked behind,
 * which Safari 15.4 cannot do (docs/phone.md).
 */
const SCREEN_WORDS = /(?:^|[^\p{L}\p{N}])(screens?|screenshot|what i see|what i'm looking at|this window|écrans?|ecrans?|ce que je vois|cette fenêtre|cette fenetre)(?![\p{L}\p{N}])/iu;

export const mentionsScreen = (text: string): boolean => SCREEN_WORDS.test(text);

/** One capture as a JPEG under `budget` bytes; null when it failed or stays too heavy. */
function toImage(buffer: ArrayBuffer | null, name: string, budget: number): ImageAttachment | null {
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
    if ((data.length * 3) / 4 <= budget) return { kind: 'image', mimeType: 'image/jpeg', data, name };
  }
  return null;
}

/**
 * Every screen, the main one first, or the screen the companion is on; with a
 * single screen both are that one. Null outside the shell or when a capture failed.
 */
export async function captureScreens(scope: 'all' | 'here'): Promise<ScreenShot | null> {
  const monitors = scope === 'all' ? await companionMonitors() : [];
  if (monitors.length > 1) {
    const ordered = [...monitors].sort((a, b) => Number(b.primary) - Number(a.primary)).slice(0, ATTACHMENTS_PER_TURN);
    const budget = Math.min(MAX_BYTES, TOTAL_BYTES / ordered.length);
    const images: ImageAttachment[] = [];
    // One after the other: each capture hides the companion from it for a moment.
    for (const [index, monitor] of ordered.entries()) {
      const image = toImage(await captureScreen({ monitor: monitor.name }), `screen-${index + 1}.jpg`, budget);
      if (!image) return null;
      images.push(image);
    }
    return { images, seen: { kind: 'screens', count: images.length } };
  }
  const image = toImage(await captureScreen(), 'screen.jpg', MAX_BYTES);
  return image && { images: [image], seen: { kind: 'screen' } };
}

/** `area` of the window, while it covers a screen; null when the capture failed. */
export async function captureZone(area: HitRect): Promise<ScreenShot | null> {
  const image = toImage(await captureScreen({ area }), 'zone.jpg', MAX_BYTES);
  return image && { images: [image], seen: { kind: 'zone' } };
}
