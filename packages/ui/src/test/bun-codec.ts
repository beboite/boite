/**
 * `ImageCodec` on Bun's real encoders (`src/test/bun-image.ts`), for a test
 * that must weigh true JPEGs and PNGs where jsdom has no canvas. Start it
 * once, close it after: it holds one Bun process.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import type { Decoded, ImageCodec } from '../lib/image-prepare';

// jsdom's `import.meta.url` is not a file URL; Vitest runs from the package root.
const SCRIPT = resolve(process.cwd(), 'src/test/bun-image.ts');

export interface BunCodec {
  codec: ImageCodec;
  close(): void;
}

async function base64(blob: Blob): Promise<string> {
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onerror = () => reject(new Error('unreadable'));
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
    reader.readAsDataURL(blob);
  });
}

export function startBunCodec(): BunCodec {
  const child: ChildProcessWithoutNullStreams = spawn('bun', [SCRIPT], { stdio: 'pipe' });
  const waiting = new Map<number, (reply: Record<string, unknown>) => void>();
  let next = 0;
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (text: string) => {
    buffered += text;
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const reply = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown> & { id: number };
      buffered = buffered.slice(newline + 1);
      waiting.get(reply.id)?.(reply);
      waiting.delete(reply.id);
    }
  });
  const ask = (request: Record<string, unknown>): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, reply => (reply.error ? reject(new Error(String(reply.error))) : resolve(reply)));
    child.stdin.write(`${JSON.stringify({ id, ...request })}\n`);
  });
  const codec: ImageCodec = {
    async decode(file) {
      const data = await base64(file);
      const size = await ask({ op: 'size', data });
      const decoded: Decoded = {
        width: Number(size.width),
        height: Number(size.height),
        hasAlpha: () => false,
        async encode(width, height, mimeType, quality) {
          const reply = await ask({ op: 'encode', data, width, height, mimeType, quality });
          return new Blob([Buffer.from(String(reply.data), 'base64')], { type: mimeType });
        },
        close() {}
      };
      return decoded;
    }
  };
  return { codec, close: () => { child.stdin.end(); child.kill(); } };
}
