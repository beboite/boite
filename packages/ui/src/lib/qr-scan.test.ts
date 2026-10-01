import { create } from 'qrcode';
import { expect, test } from 'vitest';
import { cameraFailure, decodeFrame } from './qr-scan';

/** A pairing link drawn the way the desktop card draws it, as the RGBA pixels a camera frame is. */
function frame(text: string, scale = 6, margin = 4): { data: Uint8ClampedArray; side: number } {
  const { modules } = create(text, { errorCorrectionLevel: 'M' });
  const side = (modules.size + margin * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < side; y += 1) for (let x = 0; x < side; x += 1) {
    const row = Math.floor(y / scale) - margin, column = Math.floor(x / scale) - margin;
    if (row < 0 || column < 0 || row >= modules.size || column >= modules.size || !modules.get(row, column)) continue;
    data.fill(0, (y * side + x) * 4, (y * side + x) * 4 + 3);
  }
  return { data, side };
}

test('the fallback decoder reads the pairing link the desktop card draws', async () => {
  const link = `https://boite.example.com/?grant=${'ab'.repeat(32)}`;
  const { data, side } = frame(link);
  expect(await decodeFrame(data, side, side)).toBe(link);
  expect(await decodeFrame(new Uint8ClampedArray(side * side * 4).fill(255), side, side)).toBeNull();
});

test('a page without a camera API says HTTPS, a refusal says permission', () => {
  // jsdom has no mediaDevices, which is what a phone on plain HTTP sees.
  expect(cameraFailure()).toBe('insecure');
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => Promise.reject(new Error('no')) } });
  try {
    expect(cameraFailure({ name: 'NotAllowedError' })).toBe('denied');
    expect(cameraFailure({ name: 'NotFoundError' })).toBe('missing');
    expect(cameraFailure(new Error('boom'))).toBe('failed');
  } finally {
    delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
  }
});
