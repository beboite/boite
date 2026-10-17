import { qrMatrix } from '../../../packages/ui/src/lib/qr.ts';

/** One frame of raw YUV 4:2:0 video, the QR code of `text` black on white in its middle: what Chromium's fake camera plays. */
export function codeVideo(text: string, width = 640, height = 480): Uint8Array {
  const modules = qrMatrix(text);
  const scale = Math.floor((height * 0.8) / modules.length);
  const left = Math.floor((width - modules.length * scale) / 2), top = Math.floor((height - modules.length * scale) / 2);
  const luma = new Uint8Array(width * height).fill(235);
  modules.forEach((line, row) => line.forEach((dark, column) => {
    if (!dark) return;
    for (let y = 0; y < scale; y += 1) luma.fill(16, (top + row * scale + y) * width + left + column * scale, (top + row * scale + y) * width + left + (column + 1) * scale);
  }));
  const chroma = new Uint8Array((width * height) / 2).fill(128);
  return Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420jpeg\nFRAME\n`), luma, chroma]);
}
