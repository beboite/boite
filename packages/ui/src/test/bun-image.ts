/**
 * A real image codec for tests that run outside a browser: Bun's own
 * (`Bun.Image`), behind JSON lines on stdin and stdout. jsdom has no canvas,
 * so a test that must weigh true encodings starts this under Bun
 * (`src/test/bun-codec.ts`) and talks to it. One request a line:
 * `{ id, op: 'size', data }` answers `{ id, width, height }` and
 * `{ id, op: 'encode', data, width, height, mimeType, quality }` answers
 * `{ id, data }`, base64 both ways; a failure answers `{ id, error }`.
 */
type Ask = { id: number; op: 'size' | 'encode'; data: string; width?: number; height?: number; mimeType?: string; quality?: number };

/** The part of Bun's API used here: this package is typed for the browser, not for Bun. */
interface BunImage {
  metadata(): Promise<{ width: number; height: number }>;
  resize(width: number, height: number, options: { fit: 'fill' }): BunImage;
  png(): BunImage;
  jpeg(options: { quality: number }): BunImage;
  bytes(): Promise<Uint8Array>;
}
declare const Bun: { Image: new (source: Uint8Array) => BunImage; stdin: { stream(): AsyncIterable<Uint8Array> } };

const decoder = new TextDecoder();
let buffered = '';

async function answer(request: Ask): Promise<Record<string, unknown>> {
  const source = Buffer.from(request.data, 'base64');
  if (request.op === 'size') {
    const { width, height } = await new Bun.Image(source).metadata();
    return { width, height };
  }
  const resized = new Bun.Image(source).resize(request.width!, request.height!, { fit: 'fill' });
  const encoded = request.mimeType === 'image/png' ? resized.png() : resized.jpeg({ quality: Math.round((request.quality ?? 0.92) * 100) });
  return { data: Buffer.from(await encoded.bytes()).toString('base64') };
}

for await (const piece of Bun.stdin.stream()) {
  buffered += decoder.decode(piece, { stream: true });
  let newline: number;
  while ((newline = buffered.indexOf('\n')) >= 0) {
    const request = JSON.parse(buffered.slice(0, newline)) as Ask;
    buffered = buffered.slice(newline + 1);
    let reply: Record<string, unknown>;
    try { reply = await answer(request); } catch (error) { reply = { error: String(error) }; }
    process.stdout.write(`${JSON.stringify({ id: request.id, ...reply })}\n`);
  }
}

export {};
