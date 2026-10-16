import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { RPC_CHUNK_BYTES, RPC_CHUNK_MARK, type MessageId, type RpcEvents } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { isLoopbackHost, ServerConnection, staticResponse } from '../src/server.ts';
import { slices } from '../src/server/connection.ts';
import { startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore({});
});

afterEach(async () => {
  await harness.stop();
});

interface Sent {
  frame: { method?: string; id?: number; params?: { text?: string } };
  compressed: boolean | undefined;
}

function attached(remote: boolean): { connection: ServerConnection; sent: Sent[] } {
  const sent: Sent[] = [];
  const connection = new ServerConnection(harness.core, remote);
  connection.attach({
    getBufferedAmount: () => 0,
    send: (frame: string, compress?: boolean) => { sent.push({ frame: JSON.parse(frame), compressed: compress }); return frame.length; },
    close: () => undefined,
  } as unknown as Parameters<ServerConnection['attach']>[0]);
  return { connection, sent };
}

const delta = (text: string, messageId = 'msg_a'): RpcEvents['message.delta'] =>
  ({ threadId: 'thr_a', messageId, partIndex: 0, text }) as RpcEvents['message.delta'];

describe('what a remote client is sent', () => {
  test('only a loopback Host is local', () => {
    for (const host of ['127.0.0.1:4321', 'localhost:4321', 'LOCALHOST', '[::1]:4321', '127.0.0.1']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ['192.0.2.7:4321', 'boite.example', 'phone.example:443', '127.0.0.1.example:80', '', null]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  test('a local connection gets every delta at once and uncompressed', () => {
    const { connection, sent } = attached(false);
    connection.sendEvent('message.delta', delta('one'));
    connection.sendEvent('message.delta', delta(' two'));
    expect(sent.map((entry) => entry.frame.params?.text)).toEqual(['one', ' two']);
    expect(sent.every((entry) => entry.compressed === false)).toBe(true);
  });

  test('a remote connection holds deltas for a window, joins them per part and compresses the frame', async () => {
    const { connection, sent } = attached(true);
    connection.sendEvent('message.delta', delta('one'));
    connection.sendEvent('message.delta', delta(' two'));
    connection.sendEvent('message.delta', delta('other', 'msg_b'));
    expect(sent).toEqual([]);
    await Bun.sleep(120);
    expect(sent.map((entry) => entry.frame.params?.text)).toEqual(['one two', 'other']);
    expect(sent.every((entry) => entry.compressed === true)).toBe(true);
    connection.close(1000, 'done');
  });

  test('held deltas leave before any other event and before a response, so the order on the wire is the order of the turn', () => {
    const { connection, sent } = attached(true);
    connection.sendEvent('message.delta', delta('tail'));
    connection.sendEvent('turn.finished', { threadId: 'thr_a' } as unknown as RpcEvents['turn.finished']);
    connection.sendEvent('message.delta', delta('late'));
    connection.sendResponse({ jsonrpc: '2.0', id: 7, result: null });
    expect(sent.map((entry) => entry.frame.method ?? `response ${entry.frame.id}`)).toEqual([
      'message.delta', 'turn.finished', 'message.delta', 'response 7',
    ]);
    connection.close(1000, 'done');
  });

  test('pacing flushes bounded distinct parts before the next frame', () => {
    const { connection, sent } = attached(true);
    for (let index = 0; index < 1025; index++) connection.sendEvent('message.delta', delta('x', `msg_${index}`));
    expect(sent).toHaveLength(1024);
    connection.sendResponse({ jsonrpc: '2.0', id: 1, result: 'ok' });
    expect(sent).toHaveLength(1026);
    expect(sent[1024]!.frame.params?.text).toBe('x');
    expect(sent[1025]!.frame.id).toBe(1);
    connection.close(1000);
  });

  test('closing drops what was held', async () => {
    const { connection, sent } = attached(true);
    connection.sendEvent('message.delta', delta('never'));
    connection.close(1000, 'gone');
    await Bun.sleep(120);
    expect(sent).toEqual([]);
  });
});

describe('an answer a client counts', () => {
  /** `buffered` is what the fake socket says is still waiting to leave. */
  function raw(remote: boolean, congestionTimeoutMs?: number): { connection: ServerConnection; frames: string[]; socket: { buffered: number; closed: number | null } } {
    const frames: string[] = [];
    const socket = { buffered: 0, closed: null as number | null };
    const connection = new ServerConnection(harness.core, remote, congestionTimeoutMs);
    connection.attach({
      send: (frame: string) => { frames.push(frame); return frame.length; },
      getBufferedAmount: () => socket.buffered,
      close: (code: number) => { socket.closed = code; },
    } as unknown as Parameters<ServerConnection['attach']>[0]);
    return { connection, frames, socket };
  }

  test('a long answer to a request that asked for progress leaves in counted slices that join into the frame', () => {
    const { connection, frames } = raw(false);
    // Non-ASCII text, so bytes and characters differ and a slice may end inside a pair.
    const result = { text: 'é😀'.repeat(RPC_CHUNK_BYTES) };
    connection.sendResponse({ jsonrpc: '2.0', id: 9, result }, true);
    const whole = JSON.stringify({ jsonrpc: '2.0', id: 9, result });
    expect(frames.length).toBeGreaterThan(2);
    let joined = '';
    let counted = 0;
    for (const frame of frames) {
      expect(frame.startsWith(RPC_CHUNK_MARK)).toBe(true);
      const cut = frame.indexOf('\n');
      const header = JSON.parse(frame.slice(RPC_CHUNK_MARK.length, cut)) as { id: number; bytes: number; total: number };
      const body = frame.slice(cut + 1);
      expect(header).toEqual({ id: 9, bytes: Buffer.byteLength(body), total: Buffer.byteLength(whole) });
      // No slice starts or ends on half a surrogate pair.
      expect(Buffer.from(body).toString()).toBe(body);
      joined += body;
      counted += header.bytes;
    }
    expect(joined).toBe(whole);
    expect(counted).toBe(Buffer.byteLength(whole));
    connection.close(1000, 'done');
  });

  test('slices wait for the socket to drain, and every frame written meanwhile leaves after the last one', () => {
    const { connection, frames, socket } = raw(false);
    socket.buffered = 2 * 1024 * 1024;
    connection.sendResponse({ jsonrpc: '2.0', id: 4, result: 'x'.repeat(RPC_CHUNK_BYTES * 3) }, true);
    connection.sendEvent('turn.finished', { threadId: 'thr_a' } as unknown as RpcEvents['turn.finished']);
    connection.sendResponse({ jsonrpc: '2.0', id: 5, result: null });
    // A socket that far behind gets nothing more until it drains.
    expect(frames).toEqual([]);
    socket.buffered = 0;
    connection.drain();
    const kinds = frames.map((frame) => {
      if (frame.startsWith(RPC_CHUNK_MARK)) return 'slice';
      const parsed = JSON.parse(frame) as { method?: string; id?: number };
      return parsed.method ?? `response ${parsed.id}`;
    });
    expect(kinds).toEqual(['slice', 'slice', 'slice', 'slice', 'turn.finished', 'response 5']);
    // Empty again, a frame goes straight out.
    connection.sendResponse({ jsonrpc: '2.0', id: 6, result: null });
    expect(frames).toHaveLength(7);
    connection.close(1000, 'done');
  });

  test('a long answer on a slow socket keeps the connection while each drain takes more of it', async () => {
    const { connection, frames, socket } = raw(true, 100);
    socket.buffered = 2 * 1024 * 1024;
    connection.sendResponse({ jsonrpc: '2.0', id: 3, result: 'x'.repeat(RPC_CHUNK_BYTES * 40) }, true);
    // Each drain lets out some slices; together they take longer than the congestion limit.
    for (let round = 0; round < 6 && frames.length < 41; round += 1) {
      await Bun.sleep(60);
      socket.buffered = 0;
      const before = frames.length;
      // Bun reports the buffer filling again as the slices leave.
      const send = frames.push.bind(frames);
      frames.push = (...items: string[]) => { socket.buffered += 300 * 1024; return send(...items); };
      connection.drain();
      frames.push = send;
      expect(frames.length).toBeGreaterThan(before);
    }
    expect(socket.closed).toBeNull();
    socket.buffered = 0;
    connection.drain();
    expect(frames.join('').length).toBeGreaterThan(RPC_CHUNK_BYTES * 40);
    expect(socket.closed).toBeNull();
    connection.close(1000, 'done');
  });

  test('a short answer, or one nobody counts, goes whole', () => {
    const { connection, frames } = raw(false);
    connection.sendResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } }, true);
    connection.sendResponse({ jsonrpc: '2.0', id: 2, result: 'x'.repeat(RPC_CHUNK_BYTES * 3) });
    expect(frames).toHaveLength(2);
    expect(frames.every((frame) => frame.startsWith('{'))).toBe(true);
    connection.close(1000, 'done');
  });

  test('slices never split a surrogate pair', () => {
    const text = 'a😀'.repeat(10);
    for (const size of [1, 2, 3, 4]) {
      const pieces = [...slices(text, size)];
      expect(pieces.join('')).toBe(text);
      for (const piece of pieces) expect(Buffer.from(piece).toString()).toBe(piece);
    }
  });
});

describe('static files', () => {
  test('the compressed sibling is served when the browser reads it, with the type of the original', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'boite-static-'));
    try {
      const file = join(directory, 'index-ab.js');
      const body = 'export const answer = 42;\n'.repeat(80);
      writeFileSync(file, body);
      writeFileSync(`${file}.gz`, gzipSync(body));

      const gz = staticResponse(file, '/assets/index-ab.js', 'gzip, deflate, br');
      expect(gz.headers.get('content-encoding')).toBe('gzip');
      expect(gz.headers.get('content-type')).toContain('javascript');
      expect(gz.headers.get('vary')).toBe('accept-encoding');
      expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await gz.arrayBuffer())))).toBe(body);

      // A coding named at q=0 is refused, not asked for.
      const refused = staticResponse(file, '/assets/index-ab.js', 'gzip;q=0, identity');
      expect(refused.headers.get('content-encoding')).toBeNull();
      expect(staticResponse(file, '/assets/index-ab.js', 'br;q=0.2, gzip;q=0.8').headers.get('content-encoding')).toBe('gzip');

      // No `.br` beside it, and a client that reads nothing compressed.
      const plain = staticResponse(file, '/assets/index-ab.js', null);
      expect(plain.headers.get('content-encoding')).toBeNull();
      expect(plain.headers.get('vary')).toBe('accept-encoding');
      expect(await plain.text()).toBe(body);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('threads.get after', () => {
  async function seeded(): Promise<{ client: Awaited<ReturnType<typeof connect>>; threadId: string; ids: MessageId[] }> {
    const client = await connect(harness.url, harness.token, { client: { name: 'test', version: '0' } });
    const project = await client.call('projects.add', { path: harness.dataDir, name: 'wire' });
    const account = (await client.call('accounts.list', {})).find((entry) => entry.providerId === 'echo');
    if (!account) throw new Error('no echo account');
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'resume' });
    for (const prompt of ['first', 'second', 'third']) {
      const done = client.next('turn.finished', (event) => event.threadId === thread.id, 20_000);
      await client.call('turns.start', { threadId: thread.id, prompt });
      await done;
    }
    const full = await client.call('threads.get', { threadId: thread.id });
    return { client, threadId: thread.id, ids: full.messages.map((message) => message.id) };
  }

  test('the answer starts at the named message and says so', async () => {
    const { client, threadId, ids } = await seeded();
    try {
      const anchor = ids[ids.length - 2] as MessageId;
      const tail = await client.call('threads.get', { threadId, after: anchor });
      expect(tail.messagesFrom).toBe(anchor);
      expect(tail.messages.map((message) => message.id)).toEqual(ids.slice(-2));
      expect(tail.turns.length).toBeGreaterThan(0);
    } finally {
      client.close();
    }
  });

  test('a message the journal does not hold gets the whole page, unmarked', async () => {
    const { client, threadId, ids } = await seeded();
    try {
      const whole = await client.call('threads.get', { threadId, after: 'msg_never_written' as MessageId });
      expect(whole.messagesFrom).toBeUndefined();
      expect(whole.messages.map((message) => message.id)).toEqual(ids);
    } finally {
      client.close();
    }
  });
});
