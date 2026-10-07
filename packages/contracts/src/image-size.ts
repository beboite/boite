/*
 * The size a picture is drawn at, read from the first bytes of its base64:
 * what lets a page give a deferred image its box before a byte of it arrives.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGITS = new Map([...ALPHABET].map((char, value) => [char.charCodeAt(0), value]));

/**
 * The first bytes of a base64 string, decoded by hand: this module runs in the
 * core and in the browser, and neither `atob` nor `Buffer` is common to both
 * type libraries. Null on a character outside the alphabet.
 */
function prefix(data: string, chars: number): Uint8Array | null {
  const length = Math.min(data.length, chars - (chars % 4));
  const bytes = new Uint8Array(Math.floor((length * 3) / 4));
  let written = 0;
  let bits = 0;
  let held = 0;
  for (let i = 0; i < length; i += 1) {
    const code = data.charCodeAt(i);
    if (code === 61) break; // '=': the padding ends the bytes
    const value = DIGITS.get(code);
    if (value === undefined) return null;
    held = (held << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written++] = (held >> bits) & 0xff;
    }
  }
  return bytes.subarray(0, written);
}

type Size = { width: number; height: number };

const u16be = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number) => u16le(b, at) | ((b[at + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, at: number) => ((u16be(b, at) << 16) >>> 0) + u16be(b, at + 2);
const u32le = (b: Uint8Array, at: number) => ((u16le(b, at + 2) << 16) >>> 0) + u16le(b, at);
const ascii = (b: Uint8Array, at: number, text: string) => [...text].every((char, i) => b[at + i] === char.charCodeAt(0));

function sized(width: number, height: number): Size | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

/** The orientation tag of an EXIF segment, `data` its bytes from `Exif\0\0` on. 1 when absent or unreadable. */
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  if (!ascii(b, start, 'Exif\0\0')) return 1;
  const tiff = start + 6;
  const little = ascii(b, tiff, 'II');
  if (!little && !ascii(b, tiff, 'MM')) return 1;
  const u16 = (at: number) => (little ? u16le(b, at) : u16be(b, at));
  const u32 = (at: number) => (little ? u32le(b, at) : u32be(b, at));
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let entry = 0; entry < count; entry += 1) {
    const at = ifd + 2 + entry * 12;
    if (at + 12 > end) return 1;
    if (u16(at) === 0x0112) {
      const value = u16(at + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** A JPEG's frame size, walking its segments; `more` when the prefix ended first. */
function jpegSize(b: Uint8Array): Size | null | 'more' {
  let orientation = 1;
  let at = 2;
  for (;;) {
    if (at + 4 > b.length) return 'more';
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1] ?? 0;
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    // The scan or the end before any frame header: nothing to read a size from.
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = u16be(b, at + 2);
    if (length < 2) return null;
    const end = at + 2 + length;
    // SOF0 to SOF15, less DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > b.length) return 'more';
      const height = u16be(b, at + 5);
      const width = u16be(b, at + 7);
      // 5 to 8 turn the picture a quarter: the browser draws it that way round.
      return orientation >= 5 ? sized(height, width) : sized(width, height);
    }
    if (marker === 0xe1 && orientation === 1) {
      if (end > b.length) return 'more';
      orientation = exifOrientation(b, at + 4, end);
    }
    at = end;
  }
}

function sizeOf(b: Uint8Array): Size | null | 'more' {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 'PNG\r\n\x1a\n') && ascii(b, 12, 'IHDR')) {
    return sized(u32be(b, 16), u32be(b, 20));
  }
  if (b.length >= 10 && (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'))) return sized(u16le(b, 6), u16le(b, 8));
  if (b.length >= 30 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) {
    if (ascii(b, 12, 'VP8 ') && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return sized(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
    }
    if (ascii(b, 12, 'VP8L') && b[20] === 0x2f) {
      const bits = u32le(b, 21);
      return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (ascii(b, 12, 'VP8X')) return sized(u24le(b, 24) + 1, u24le(b, 27) + 1);
    return null;
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) return jpegSize(b);
  return null;
}

/**
 * The size an image is drawn at, read from the header of its base64 bytes:
 * PNG, GIF, WebP and JPEG, the last with its EXIF orientation applied as a
 * browser applies it. Only the start is decoded, a little more for a JPEG
 * whose metadata comes before its frame. Null for anything else.
 */
export function imageSize(data: string): Size | null {
  let chars = 4096;
  for (;;) {
    const bytes = prefix(data, chars);
    if (bytes === null) return null;
    const size = sizeOf(bytes);
    if (size !== 'more') return size;
    if (chars >= data.length) return null;
    chars *= 16;
  }
}
