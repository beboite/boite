/**
 * Screenshots a test can weigh: PNGs with what makes real ones heavy, lines of
 * glyph-sized marks in bubbles over a background that never repeats, so they
 * weigh a few MB like a phone's or a desktop's capture. Seeded, so a run sees
 * the same pixels every time.
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An 8-bit RGB PNG of `rgb`, three bytes a pixel, row after row. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array<ArrayBuffer> {
  const rows = new Uint8Array(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) rows.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 6 })), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
}

/** A chat-like capture: a noisy gradient background, bubbles, and text-like marks in them. */
export function screenshot(width: number, height: number, seed: number): Uint8Array<ArrayBuffer> {
  const next = random(seed);
  const rgb = new Uint8Array(width * height * 3);
  const tint = [next() * 60, next() * 60, next() * 60];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      const shade = 200 + 40 * (x / width) - 30 * (y / height);
      for (let c = 0; c < 3; c++) rgb[at + c] = Math.max(0, Math.min(255, shade - tint[c]! + (next() - 0.5) * 18));
    }
  }
  const scale = Math.max(1, Math.round(width / 1200));
  const line = 22 * scale;
  let y = 40 * scale;
  while (y < height - 3 * line) {
    const lines = 1 + Math.floor(next() * 5);
    const left = next() < 0.5;
    const bubble = Math.floor(width * (0.45 + next() * 0.4));
    const x0 = left ? 16 * scale : width - bubble - 16 * scale;
    const fill = left ? [245, 245, 248] : [70 + next() * 40, 110 + next() * 40, 230];
    const ink = left ? 30 : 250;
    for (let row = y; row < Math.min(height, y + lines * line + 12 * scale); row++) {
      for (let x = x0; x < x0 + bubble; x++) {
        const at = (row * width + x) * 3;
        for (let c = 0; c < 3; c++) rgb[at + c] = fill[c]!;
      }
    }
    for (let l = 0; l < lines; l++) {
      let x = x0 + 10 * scale;
      const top = y + 6 * scale + l * line;
      const end = x0 + bubble - 10 * scale - (l === lines - 1 ? Math.floor(next() * bubble * 0.5) : 0);
      while (x < end) {
        const word = (2 + Math.floor(next() * 8)) * 7 * scale;
        for (let gx = x; gx < Math.min(end, x + word); gx++) {
          const column = next();
          for (let gy = top; gy < top + 14 * scale; gy++) {
            if (next() < 0.45 * column + 0.1) {
              const at = (gy * width + gx) * 3;
              for (let c = 0; c < 3; c++) rgb[at + c] = ink;
            }
          }
        }
        x += word + 6 * scale;
      }
    }
    y += lines * line + 30 * scale;
  }
  return encodePng(width, height, rgb);
}
