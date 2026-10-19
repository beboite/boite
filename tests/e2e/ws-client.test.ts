import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { encodeFrame, FrameReader, TextSocket, type CloseEvent, type Frame } from './lib/ws-client.ts';

/** A server frame: unmasked, final unless told otherwise. */
function serverFrame(opcode: number, payload: Uint8Array | string, fin = true, rsv = 0): Uint8Array {
  const body = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  const n = body.length;
  const head = n < 126 ? [n] : n < 65_536 ? [126, n >> 8, n & 0xff] : [127, 0, 0, 0, 0, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const out = new Uint8Array(1 + head.length + n);
  out[0] = (fin ? 0x80 : 0) | (rsv << 4) | opcode;
  out.set(head, 1);
  out.set(body, 1 + head.length);
  return out;
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** Feeds `bytes` in slices of `cut(at)` bytes, the way TCP reads may arrive. */
function feed(bytes: Uint8Array, cut: (at: number) => number): Frame[] {
  const reader = new FrameReader();
  const frames: Frame[] = [];
  for (let at = 0; at < bytes.length;) {
    const n = Math.max(1, Math.min(cut(at), bytes.length - at));
    // A copy that is overwritten after the push, as Bun reuses its read buffer.
    const slice = bytes.slice(at, at + n);
    frames.push(...reader.push(slice));
    slice.fill(0xee);
    at += n;
  }
  return frames;
}

function seeded(seed: number): () => number {
  return () => { seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff; return seed / 0x7fffffff; };
}

const large = 'x'.repeat(300_000);
const stream = join([
  serverFrame(1, '{"id":1}'),
  serverFrame(1, 'm'.repeat(200)),
  serverFrame(1, large),
  // A message in three fragments with a ping between them, and a character split across two.
  serverFrame(1, new Uint8Array([0x68, 0xc3]), false),
  serverFrame(9, 'are you there'),
  serverFrame(0, new Uint8Array([0xa9, 0x20]), false),
  serverFrame(0, 'end'),
  serverFrame(8, join([new Uint8Array([0x03, 0xe8]), new TextEncoder().encode('bye')])),
]);
const expected: Frame[] = [
  { kind: 'text', text: '{"id":1}' },
  { kind: 'text', text: 'm'.repeat(200) },
  { kind: 'text', text: large },
  { kind: 'ping', payload: new TextEncoder().encode('are you there') },
  { kind: 'text', text: 'hé end' },
  { kind: 'close', code: 1000, reason: 'bye' },
];

test('the frame reader gives the same messages whatever the reads cut', () => {
  expect(feed(stream, () => stream.length)).toEqual(expected);
  expect(feed(stream, () => 1)).toEqual(expected);
  for (const seed of [1, 2, 3, 4, 5]) {
    const random = seeded(seed);
    expect(feed(stream, () => 1 + Math.floor(random() * (random() < 0.3 ? 12 : 9_000)))).toEqual(expected);
  }
}, 30_000);

test('the frame reader refuses what Bun mistook for frames: reserved bits, masks, long or split control frames', () => {
  const refusal = (bytes: Uint8Array) => {
    const frames = new FrameReader().push(bytes);
    const last = frames.at(-1);
    return last?.kind === 'invalid' ? last.reason : 'accepted';
  };
  // The 1011 "Compression not implemented yet" close: RSV1 with no extension negotiated.
  expect(refusal(serverFrame(1, '{}', true, 4))).toContain('reserved bits');
  const masked = serverFrame(1, '{}'); masked[1]! |= 0x80;
  expect(refusal(masked)).toBe('the server masked a frame');
  expect(refusal(serverFrame(9, 'p', false))).toContain('fragmented');
  expect(refusal(serverFrame(9, 'p'.repeat(126)))).toContain('control frame');
  expect(refusal(serverFrame(0, 'orphan'))).toContain('continuation');
  expect(refusal(join([serverFrame(1, 'a', false), serverFrame(1, 'b')]))).toContain('inside a fragmented message');
  expect(refusal(serverFrame(3, 'x'))).toBe('opcode 3');
  expect(refusal(serverFrame(1, new Uint8Array([0xc3, 0x28])))).toContain('not UTF-8');
  // What came before the fault stands; nothing after it is read.
  const reader = new FrameReader();
  expect(reader.push(join([serverFrame(1, 'kept'), serverFrame(1, '{}', true, 4), serverFrame(1, 'lost')]))).toEqual([
    { kind: 'text', text: 'kept' },
    { kind: 'invalid', reason: 'reserved bits 4 set on opcode 1 with no extension negotiated' },
  ]);
  expect(reader.push(serverFrame(1, 'later'))).toEqual([]);
});

test('client frames are masked with their length in the right width', () => {
  const mask = new Uint8Array([1, 2, 3, 4]);
  for (const size of [0, 125, 126, 65_535, 65_536, 300_000]) {
    const payload = new Uint8Array(size).map((_, i) => i & 0xff);
    const frame = encodeFrame(1, payload, mask);
    expect(frame[0]).toBe(0x81);
    expect(frame[1]! & 0x80).toBe(0x80);
    const header = size < 126 ? 2 : size < 65_536 ? 4 : 10;
    expect(frame.length).toBe(header + 4 + size);
    const unmasked = frame.subarray(header + 4).map((byte, i) => byte ^ mask[i & 3]!);
    expect(unmasked).toEqual(payload);
  }
});

test('a socket on a Bun server exchanges large and many messages, answers pings and reports the close', async () => {
  const sizes = Array.from({ length: 400 }, (_, i) => (i % 150 === 0 ? 1_000_000 : (i * 7_919) % 8_000));
  const echoed: string[] = [];
  let pong = false;
  let clientClose: number | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: (request, self) => (self.upgrade(request) ? undefined : new Response('upgrade required', { status: 426 })),
    websocket: {
      perMessageDeflate: true,
      // Everything is sent at once: past the default 16 MB Bun drops messages.
      backpressureLimit: 64 << 20,
      open(socket) {
        socket.ping('hello');
        for (const [id, size] of sizes.entries()) socket.send(JSON.stringify({ id, pad: 'é'.repeat(size) }));
      },
      message(socket, text) {
        echoed.push(String(text));
        if (echoed.length === sizes.length) socket.close(4000, 'done');
      },
      pong() { pong = true; },
      close(_socket, code) { clientClose = code; },
    },
  });
  try {
    const socket = await TextSocket.connect(`ws://127.0.0.1:${server.port}/devtools/page/a`, 5_000);
    const ids: number[] = [];
    socket.onMessage((text) => {
      const message = JSON.parse(text) as { id: number; pad: string };
      expect(message.pad.length).toBe(sizes[message.id]!);
      ids.push(message.id);
      socket.send(JSON.stringify({ id: message.id, method: 'Runtime.evaluate' }));
    });
    const closed = await new Promise<CloseEvent>((resolve) => socket.onClose(resolve));
    expect(closed).toEqual({ code: 4000, reason: 'done' });
    expect(ids).toEqual(sizes.map((_, id) => id));
    expect(echoed.length).toBe(sizes.length);
    expect(pong).toBe(true);
    expect(socket.open).toBe(false);
  } finally { await server.stop(true); }
  expect(clientClose).toBe(4000);
}, 30_000);

test('a socket closed by the client sends 1000 and ends once the server answers', async () => {
  let seen: number | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: (request, self) => (self.upgrade(request) ? undefined : new Response('no', { status: 426 })),
    websocket: { message() {}, close(_socket, code) { seen = code; } },
  });
  try {
    const socket = await TextSocket.connect(`ws://127.0.0.1:${server.port}/`, 5_000);
    const closed = new Promise<CloseEvent>((resolve) => socket.onClose(resolve));
    socket.close();
    expect(socket.open).toBe(false);
    expect((await closed).code).toBe(1000);
  } finally { await server.stop(true); }
  expect(seen).toBe(1000);
});

test('a raw server whose frames arrive cut anywhere is read whole, and a malformed one is closed with 1002', async () => {
  const random = seeded(7);
  const messages = Array.from({ length: 3_000 }, (_, id) => JSON.stringify({ id, pad: 'a'.repeat(random() < 0.05 ? 70_000 : Math.floor(random() * 3_000)) }));
  const frames = join(messages.map((text) => serverFrame(1, text)));
  const serve = (body: Uint8Array) => Bun.listen({
    hostname: '127.0.0.1', port: 0,
    socket: {
      data(socket, bytes) {
        const key = /sec-websocket-key:\s*(\S+)/i.exec(new TextDecoder().decode(bytes))?.[1];
        if (key === undefined) return;
        const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        const all = join([new TextEncoder().encode(`HTTP/1.1 101 WebSocket Protocol Handshake\r\nUpgrade: WebSocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`), body]);
        void (async () => {
          for (let at = 0; at < all.length;) {
            const part = all.subarray(at, at + 1 + Math.floor(random() * (random() < 0.3 ? 8 : 9_000)));
            at += part.length;
            for (let off = 0; off < part.length;) {
              const written = socket.write(part.subarray(off));
              if (written <= 0) await Bun.sleep(1); else off += written;
            }
            if (random() < 0.2) await Bun.sleep(0);
          }
        })();
      },
    },
  });
  const sound = serve(frames);
  try {
    const socket = await TextSocket.connect(`ws://127.0.0.1:${sound.port}/devtools/page/b`, 5_000);
    const received: string[] = [];
    await new Promise<void>((resolve) => socket.onMessage((text) => { received.push(text); if (received.length === messages.length) resolve(); }));
    expect(received).toEqual(messages);
    socket.close();
  } finally { sound.stop(true); }

  const broken = serve(join([serverFrame(1, '{"id":1}'), serverFrame(1, '{"id":2}', true, 4)]));
  try {
    const socket = await TextSocket.connect(`ws://127.0.0.1:${broken.port}/`, 5_000);
    const received: string[] = [];
    socket.onMessage((text) => received.push(text));
    const closed = await new Promise<CloseEvent>((resolve) => socket.onClose(resolve));
    expect(closed.code).toBe(1002);
    expect(closed.reason).toContain('reserved bits');
    expect(received).toEqual(['{"id":1}']);
  } finally { broken.stop(true); }
}, 30_000);

test('an upgrade the server refuses or never answers rejects with what happened', async () => {
  const refusing = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('no page', { status: 404 }) });
  try {
    await expect(TextSocket.connect(`ws://127.0.0.1:${refusing.port}/devtools/page/gone`, 5_000)).rejects.toThrow('refused the WebSocket upgrade: HTTP/1.1 404');
  } finally { await refusing.stop(true); }
  // A server that never answers the upgrade gets its connection closed: a late 101 would otherwise keep it for the run.
  let hungUp = false;
  const silent = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {}, close() { hungUp = true; } } });
  try {
    await expect(TextSocket.connect(`ws://127.0.0.1:${silent.port}/`, 300)).rejects.toThrow('no WebSocket upgrade');
    for (let waited = 0; !hungUp && waited < 2_000; waited += 20) await Bun.sleep(20);
    expect(hungUp).toBe(true);
  } finally { silent.stop(true); }
});
