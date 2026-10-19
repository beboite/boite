import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@boite/contracts';
import { Cdp } from '../src/browser/cdp.ts';
import { connect } from '../src/client.ts';

/*
 * The sockets the core opens to the browser's DevTools and to another core
 * read through `ws-client.ts`: Bun's own WebSocket client closed sound streams
 * from Chrome and from the core's server with 1002 and 1011 on CI.
 */

const SOURCE = join(import.meta.dir, '../src');

test('no product module opens a socket with Bun\'s own WebSocket client', () => {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.ts$/.test(entry.name) && /\bnew WebSocket\(/.test(readFileSync(path, 'utf8'))) found.push(path.slice(SOURCE.length + 1).replaceAll('\\', '/'));
    }
  };
  walk(SOURCE);
  expect(found).toEqual([]);
});

function serverFrame(opcode: number, text: string | Uint8Array, fin = true): Uint8Array {
  const body = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  const n = body.length;
  const head = n < 126 ? [n] : n < 65_536 ? [126, n >> 8, n & 0xff] : [127, 0, 0, 0, 0, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const out = new Uint8Array(1 + head.length + n);
  out[0] = (fin ? 0x80 : 0) | opcode;
  out.set(head, 1);
  out.set(body, 1 + head.length);
  return out;
}

/** A message as the frames that broke Bun's client: split in fragments, a ping between two of them. */
function fragmented(text: string, pieces: number, ping: boolean): Uint8Array[] {
  const body = new TextEncoder().encode(text);
  const frames: Uint8Array[] = [];
  const step = Math.ceil(body.length / pieces);
  for (let at = 0, i = 0; i < pieces; i++, at += step) {
    frames.push(serverFrame(i === 0 ? 1 : 0, body.subarray(at, Math.min(body.length, at + step)), i === pieces - 1));
    if (ping && i === 0 && pieces > 1) frames.push(serverFrame(9, 'ping'));
  }
  return frames;
}

function seeded(seed: number): () => number {
  return () => { seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff; return seed / 0x7fffffff; };
}

/** Messages of every length class, sent back to back: whole, fragmented, with pings, some of 300 KB. */
function burst(random: () => number, make: (i: number, pad: string) => string, count: number): { texts: string[]; frames: Uint8Array[] } {
  const texts: string[] = [], frames: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const size = [0, 100, 125, 126, 65_535, 65_536, 300_000][Math.floor(random() * 7)]!;
    const text = make(i, 'é'.repeat(Math.floor(size / 2)));
    texts.push(text);
    frames.push(...fragmented(text, 1 + Math.floor(random() * 3), random() < 0.5));
  }
  return { texts, frames };
}

/**
 * A server that upgrades by hand and writes its frames cut anywhere, down to
 * one byte; `reply` gets each text message the client sent.
 */
function rawServer(reply: (text: string, write: (frames: Uint8Array[]) => void) => void, random: () => number) {
  return Bun.listen({
    hostname: '127.0.0.1', port: 0,
    socket: {
      data(socket, bytes) {
        const state = socket as unknown as { upgraded?: boolean; held?: Uint8Array };
        const write = (frames: Uint8Array[]) => {
          const all = Buffer.concat(frames);
          void (async () => {
            for (let at = 0; at < all.length;) {
              const part = all.subarray(at, at + 1 + Math.floor(random() * (random() < 0.3 ? 3 : 9_000)));
              at += part.length;
              for (let off = 0; off < part.length;) {
                const written = socket.write(part.subarray(off));
                if (written <= 0) await Bun.sleep(1); else off += written;
              }
              if (random() < 0.1) await Bun.sleep(0);
            }
          })();
        };
        if (!state.upgraded) {
          const key = /sec-websocket-key:\s*(\S+)/i.exec(new TextDecoder().decode(bytes))?.[1];
          if (key === undefined) return;
          state.upgraded = true;
          const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
          socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
          return;
        }
        // Client frames: masked, whole messages, at most 64 KB here.
        let buffer: Uint8Array = state.held ? Buffer.concat([state.held, bytes]) : bytes.slice();
        for (;;) {
          if (buffer.length < 2) break;
          let length = buffer[1]! & 0x7f, header = 2;
          if (length === 126) { length = (buffer[2]! << 8) | buffer[3]!; header = 4; }
          if (buffer.length < header + 4 + length) break;
          const mask = buffer.subarray(header, header + 4);
          const payload = buffer.slice(header + 4, header + 4 + length).map((byte, i) => byte ^ mask[i & 3]!);
          if ((buffer[0]! & 0x0f) === 1) reply(new TextDecoder().decode(payload), write);
          buffer = buffer.subarray(header + 4 + length);
        }
        state.held = buffer.slice();
      },
    },
  });
}

test('the Windows DevTools connection reads fragmented and large frames sent back to back, cut anywhere', async () => {
  const random = seeded(11);
  const events = burst(random, (i, pad) => JSON.stringify({ method: 'Test.event', params: { i, pad } }), 120);
  const reply = serverFrame(1, JSON.stringify({ id: 1, result: { product: 'Chrome' } }));
  const server = rawServer((text, write) => {
    if ((JSON.parse(text) as { method?: string }).method !== 'Browser.getVersion') return;
    // The answer lands in the middle of the burst.
    write([...events.frames.slice(0, 40), reply, ...events.frames.slice(40)]);
  }, random);
  try {
    const cdp = await Cdp.connect(`ws://127.0.0.1:${server.port}/devtools/browser/x`, 5_000);
    const seen: string[] = [];
    const all = new Promise<void>((resolve) => cdp.on('Test.event', (params) => {
      seen.push(JSON.stringify({ method: 'Test.event', params }));
      if (seen.length === events.texts.length) resolve();
    }));
    expect(await cdp.send('Browser.getVersion', {}, undefined, 20_000)).toEqual({ product: 'Chrome' });
    await all;
    expect(seen).toEqual(events.texts);
    expect(cdp.open).toBe(true);
    cdp.close();
  } finally { server.stop(true); }
}, 60_000);

test('the core client reads fragmented and large frames sent back to back, cut anywhere', async () => {
  const random = seeded(13);
  const events = burst(random, (i, pad) => JSON.stringify({ jsonrpc: '2.0', method: 'thread.updated', params: { i, pad } }), 120);
  const server = rawServer((text, write) => {
    const frame = JSON.parse(text) as { id: number; method: string };
    if (frame.method === 'hello') write(fragmented(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { core: { protocolVersion: PROTOCOL_VERSION }, principal: 'owner' } }), 3, true));
    else write([...events.frames, serverFrame(1, JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { ok: true } }))]);
  }, random);
  try {
    const client = await connect(`http://127.0.0.1:${server.port}`, 'token', { timeoutMs: 5_000 });
    const seen: string[] = [];
    client.onAny((event, payload) => seen.push(JSON.stringify({ jsonrpc: '2.0', method: event, params: payload })));
    expect(await client.call('settings.get', {})).toEqual({ ok: true } as never);
    expect(seen).toEqual(events.texts);
    client.close();
  } finally { server.stop(true); }
}, 60_000);
