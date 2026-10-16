/**
 * What one `devices.frame` poll costs the core on a still screen: the full answer
 * (PNG decode, resize to 540 wide, JPEG at quality 60, base64) against the
 * `unchanged` answer, which only hashes the PNG. The screen is a 1080 by 2400
 * PNG with banded noise, heavier than a real home screen.
 *
 *   nice -n 10 bun bench/device-frame.ts full
 *   nice -n 10 bun bench/device-frame.ts unchanged
 */
import { deflateSync } from 'node:zlib';
const W = 1080, H = 2400;
function png(): Uint8Array {
  const stride = 1 + W * 3, raw = new Uint8Array(stride * H);
  let seed = 7;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const band = (Math.floor(y / 120) * 37) & 255, noise = (seed >>> 24) & 15;
    raw.set([band + noise & 255, (x >> 3) & 255, (y >> 4) + noise & 255], y * stride + 1 + x * 3);
  }
  const chunk = (type: string, data: Uint8Array) => { const body = new Uint8Array(4 + data.length); body.set(new TextEncoder().encode(type)); body.set(data, 4); const out = new Uint8Array(12 + data.length); const v = new DataView(out.buffer); v.setUint32(0, data.length); out.set(body, 4); v.setUint32(8 + data.length, Bun.hash.crc32(body)); return out; };
  const hdr = new Uint8Array(13); const v = new DataView(hdr.buffer); v.setUint32(0, W); v.setUint32(4, H); hdr.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', hdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
  return Buffer.concat(parts);
}
const bytes = png();
const N = 20;
const mode = process.argv[2];
let size = 0;
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  if (mode === 'full') {
    const jpeg = await new Bun.Image(bytes).resize(540).jpeg({ quality: 60 }).bytes();
    size = JSON.stringify({ id: crypto.randomUUID(), deviceId: 'emulator-5554', width: W, height: H, base64: Buffer.from(jpeg).toString('base64'), at: Date.now() }).length;
  } else {
    new Bun.CryptoHasher('sha1').update(bytes).digest('hex');
    size = JSON.stringify({ id: crypto.randomUUID(), deviceId: 'emulator-5554', width: W, height: H, unchanged: true, at: Date.now() }).length;
  }
}
console.log(JSON.stringify({ mode, png: bytes.length, msPerPoll: +((performance.now() - t0) / N).toFixed(2), answerBytes: size }));
