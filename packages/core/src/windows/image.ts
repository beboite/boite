/*
 * Pictures of windows: BGRA pixels from a capture backend, cropped, scaled and
 * encoded with Bun.Image, which reads a 32-bit BMP. Clips become one contact
 * sheet whose tiles carry their number and time in a small bitmap font, so
 * the sheet needs no font on the machine.
 */
import type { WindowCrop } from '@boite/contracts';
import type { WindowPixels } from '../platform/types.ts';

/** A 32-bit top-down BMP around the pixels: what Bun.Image decodes without a copy into another format. */
export function bmp({ width, height, bgra }: Pick<WindowPixels, 'width' | 'height' | 'bgra'>): Uint8Array {
  const out = new Uint8Array(54 + width * height * 4);
  const view = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;
  view.setUint32(2, out.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, -height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 32, true);
  out.set(bgra.subarray(0, width * height * 4), 54);
  return out;
}

/** The size that fits `max` on the longest side, never larger than the source. 0 keeps the source. */
export function fit(width: number, height: number, max: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (max <= 0 || longest <= max) return { width, height };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function encode(pixels: WindowPixels, format: 'png' | 'jpeg', max: number, quality = 70): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const size = fit(pixels.width, pixels.height, max);
  let image = new Bun.Image(bmp(pixels));
  if (size.width !== pixels.width) image = image.resize(size.width);
  const bytes = format === 'png' ? await image.png().bytes() : await image.jpeg({ quality }).bytes();
  return { bytes, ...size };
}

/** The rectangle in the picture's pixels, clamped to it. A crop that leaves nothing is refused by the caller. */
export function cropRect(crop: WindowCrop, width: number, height: number): { x: number; y: number; width: number; height: number } {
  const px = crop.unit === 'fraction'
    ? { x: Math.round(crop.x * width), y: Math.round(crop.y * height), width: Math.round(crop.width * width), height: Math.round(crop.height * height) }
    : { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
  const x = Math.min(px.x, width), y = Math.min(px.y, height);
  return { x, y, width: Math.min(px.width, width - x), height: Math.min(px.height, height - y) };
}

export function cropPixels(pixels: WindowPixels, rect: { x: number; y: number; width: number; height: number }): WindowPixels {
  const out = new Uint8Array(rect.width * rect.height * 4);
  for (let row = 0; row < rect.height; row++) {
    const from = ((rect.y + row) * pixels.width + rect.x) * 4;
    out.set(pixels.bgra.subarray(from, from + rect.width * 4), row * rect.width * 4);
  }
  return { width: rect.width, height: rect.height, bgra: out, via: pixels.via };
}

/** An area-average shrink to `width` x `height`, for clip tiles: each output pixel averages the source block under it. */
export function shrink(pixels: WindowPixels, width: number, height: number): WindowPixels {
  if (width >= pixels.width && height >= pixels.height) return pixels;
  const out = new Uint8Array(width * height * 4);
  const sx = pixels.width / width, sy = pixels.height / height;
  // At most 4 samples a side: a 4K window shrinks in tens of milliseconds and still averages away aliasing.
  const stepX = Math.max(1, Math.floor(sx / 4)), stepY = Math.max(1, Math.floor(sy / 4));
  const src = pixels.bgra;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let b = 0, g = 0, r = 0, n = 0;
      for (let yy = y0; yy < y1; yy += stepY) {
        let at = (yy * pixels.width + x0) * 4;
        for (let xx = x0; xx < x1; xx += stepX, at += stepX * 4) { b += src[at]!; g += src[at + 1]!; r += src[at + 2]!; n++; }
      }
      const to = (y * width + x) * 4;
      out[to] = b / n; out[to + 1] = g / n; out[to + 2] = r / n; out[to + 3] = 255;
    }
  }
  return { width, height, bgra: out, via: pixels.via };
}

/** 5x7 glyphs, one row a byte, high bit on the left: what a tile label uses. */
const GLYPHS: Record<string, number[]> = {
  '0': [0x70, 0x88, 0x98, 0xa8, 0xc8, 0x88, 0x70], '1': [0x20, 0x60, 0x20, 0x20, 0x20, 0x20, 0x70],
  '2': [0x70, 0x88, 0x08, 0x10, 0x20, 0x40, 0xf8], '3': [0xf8, 0x10, 0x20, 0x10, 0x08, 0x88, 0x70],
  '4': [0x10, 0x30, 0x50, 0x90, 0xf8, 0x10, 0x10], '5': [0xf8, 0x80, 0xf0, 0x08, 0x08, 0x88, 0x70],
  '6': [0x30, 0x40, 0x80, 0xf0, 0x88, 0x88, 0x70], '7': [0xf8, 0x08, 0x10, 0x20, 0x40, 0x40, 0x40],
  '8': [0x70, 0x88, 0x88, 0x70, 0x88, 0x88, 0x70], '9': [0x70, 0x88, 0x88, 0x78, 0x08, 0x10, 0x60],
  '#': [0x50, 0x50, 0xf8, 0x50, 0xf8, 0x50, 0x50], '.': [0, 0, 0, 0, 0, 0x60, 0x60],
  s: [0, 0, 0x70, 0x80, 0x70, 0x08, 0xf0], ' ': [0, 0, 0, 0, 0, 0, 0],
};

const SCALE = 2;
const GAP = 8;
const LABEL = 7 * SCALE + 8;

function text(target: WindowPixels, label: string, left: number, top: number): void {
  let x = left;
  for (const char of label) {
    const glyph = GLYPHS[char] ?? GLYPHS[' ']!;
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (!(glyph[row]! & (0x80 >> col))) continue;
        for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) {
          const px = x + col * SCALE + dx, py = top + row * SCALE + dy;
          if (px >= target.width || py >= target.height) continue;
          target.bgra.fill(235, (py * target.width + px) * 4, (py * target.width + px) * 4 + 3);
        }
      }
    }
    x += 6 * SCALE;
  }
}

export interface SheetFrame {
  pixels: WindowPixels;
  /** Seconds since the first frame. */
  at: number;
}

/** The columns a sheet of `count` tiles takes: close to square, never more than the tiles. */
export const sheetColumns = (count: number) => Math.min(count, Math.ceil(Math.sqrt(count)));

/** The size of each tile of a sheet of `count` frames, so a clip shrinks every frame as it comes instead of holding full pictures. */
export function sheetTile(count: number, source: { width: number; height: number }, max: number): { width: number; height: number } {
  const columns = sheetColumns(count);
  const across = Math.min(max > 0 ? max : columns * source.width + (columns + 1) * GAP, 8192);
  const width = Math.max(16, Math.min(source.width, Math.floor((across - (columns + 1) * GAP) / columns)));
  return { width, height: Math.max(1, Math.round(source.height * width / source.width)) };
}

/**
 * One picture of every frame in a grid, each tile labelled `#n  t.ts`. The
 * sheet's width fits `max` (0: tiles at the window's size, up to 8192 pixels
 * across); tiles keep the window's proportions.
 */
export function contactSheet(frames: SheetFrame[], source: { width: number; height: number }, max: number): WindowPixels {
  const columns = sheetColumns(frames.length), rows = Math.ceil(frames.length / columns);
  const { width: tileWidth, height: tileHeight } = sheetTile(frames.length, source, max);
  const width = columns * tileWidth + (columns + 1) * GAP;
  const height = rows * (tileHeight + LABEL) + (rows + 1) * GAP;
  const sheet: WindowPixels = { width, height, bgra: new Uint8Array(width * height * 4), via: frames[0]?.pixels.via ?? '' };
  for (let at = 0; at < sheet.bgra.length; at += 4) { sheet.bgra[at] = 32; sheet.bgra[at + 1] = 32; sheet.bgra[at + 2] = 32; sheet.bgra[at + 3] = 255; }
  frames.forEach((frame, index) => {
    const tile = shrink(frame.pixels, tileWidth, tileHeight);
    const left = GAP + (index % columns) * (tileWidth + GAP);
    const top = GAP + Math.floor(index / columns) * (tileHeight + LABEL + GAP);
    const drawWidth = Math.min(tile.width, tileWidth), drawHeight = Math.min(tile.height, tileHeight);
    for (let row = 0; row < drawHeight; row++) {
      const from = row * tile.width * 4;
      sheet.bgra.set(tile.bgra.subarray(from, from + drawWidth * 4), ((top + row) * width + left) * 4);
    }
    text(sheet, `#${index + 1}  ${frame.at.toFixed(2)}s`, left + 2, top + tileHeight + 4);
  });
  return sheet;
}
