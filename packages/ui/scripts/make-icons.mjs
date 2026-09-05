import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const INK = [0x16, 0x16, 0x14, 0xff];
const MARK = [0x4f, 0xbf, 0xad, 0xff];

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const o = (y * size + x) * 4;
    buf[o] = c[0];
    buf[o + 1] = c[1];
    buf[o + 2] = c[2];
    buf[o + 3] = c[3];
  };
  const rect = (x0, y0, x1, y1, c) => {
    for (let y = Math.round(y0); y < Math.round(y1); y++)
      for (let x = Math.round(x0); x < Math.round(x1); x++) put(x, y, c);
  };

  rect(0, 0, size, size, INK);

  const stroke = Math.max(2, Math.round(size * 0.075));
  const inset = size * 0.2;
  const left = inset;
  const right = size - inset;
  const top = size * 0.26;
  const bottom = size - inset;
  const seam = top + (bottom - top) * 0.34;

  rect(left, top, right, top + stroke, MARK);
  rect(left, bottom - stroke, right, bottom, MARK);
  rect(left, top, left + stroke, bottom, MARK);
  rect(right - stroke, top, right, bottom, MARK);
  rect(left, seam, right, seam + stroke, MARK);

  const notchWidth = (right - left) * 0.22;
  const cx = (left + right) / 2;
  rect(cx - notchWidth / 2, seam, cx + notchWidth / 2, seam + stroke * 2.6, INK);

  return buf;
}

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(here, '..', 'public', 'icons');
mkdirSync(iconsDir, { recursive: true });

for (const size of [192, 512]) {
  writeFileSync(join(iconsDir, `icon-${size}.png`), encodePng(size, size, draw(size)));
}
writeFileSync(join(here, '..', 'public', 'icons', 'icon-source-1024.png'), encodePng(1024, 1024, draw(1024)));

process.stdout.write(`icons written to ${iconsDir}\n`);
