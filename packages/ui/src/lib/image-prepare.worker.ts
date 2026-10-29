/*
 * Brings pasted, dropped and picked pictures to a sendable size off the main
 * thread (`prepareImageAway` in `image-prepare.ts`). A picture its decoder
 * cannot read answers null, and the page tries it with its own image element.
 */
import { offscreenCodec, prepareImage, type Prepared } from './image-prepare';

self.onmessage = async ({ data }: MessageEvent<{ id: number; file: File }>) => {
  let undecoded = false;
  let prepared: Prepared | null = null;
  try {
    prepared = await prepareImage(data.file, {
      async decode(file) {
        const decoded = await offscreenCodec.decode(file);
        if (decoded === null) undecoded = true;
        return decoded;
      }
    });
  } catch { prepared = null; }
  self.postMessage({ id: data.id, prepared: undecoded ? null : prepared });
};
