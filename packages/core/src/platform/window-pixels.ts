/*
 * What every window capture backend shares: its error and the black-picture
 * test. No native import here, so the service and the tests load it anywhere.
 */
import type { WindowCaptureFailure, WindowPixels } from './types.ts';

export class WindowCaptureError extends Error {
  constructor(readonly code: WindowCaptureFailure, message: string) {
    super(message);
    this.name = 'WindowCaptureError';
  }
}

export const minimizedError = () => new WindowCaptureError('minimized', 'window minimized: restore it first');
export const goneError = (id: string) => new WindowCaptureError('gone', `window ${id} is gone: list the windows again`);

/**
 * Whether the picture has nothing in it: every sampled pixel black, as an
 * exclusive fullscreen game or a DRM-protected window comes out. Alpha is not
 * read: GDI leaves it 0 on a picture with content. Samples about 64k pixels,
 * so a 4K window costs no more than a small one.
 */
export function isBlank(pixels: WindowPixels): boolean {
  const { width, height, bgra } = pixels;
  const count = width * height;
  if (count === 0 || bgra.length < count * 4) return true;
  const step = Math.max(1, Math.floor(count / 65_536));
  for (let index = 0; index < count; index += step) {
    const at = index * 4;
    if (bgra[at]! > 8 || bgra[at + 1]! > 8 || bgra[at + 2]! > 8) return false;
  }
  return true;
}
