import { expect, test } from 'bun:test';
import { PROTOCOL_VERSION } from '@boite/contracts';
import { connect } from '../src/client.ts';

test.each(['hello', 'call'] as const)('client bounds an unanswered %s and closes a failed handshake', async (phase) => {
  let closed = false;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request, self) { return self.upgrade(request) ? undefined : new Response('upgrade required'); },
    websocket: {
      message(socket, raw) {
        const frame = JSON.parse(String(raw));
        if (phase === 'call' && frame.method === 'hello') socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { core: { protocolVersion: PROTOCOL_VERSION }, principal: 'owner' } }));
      },
      close() { closed = true; },
    },
  });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  const result = (async () => {
    client = await connect(`http://127.0.0.1:${server.port}`, 'test', { timeoutMs: 25, requestTimeoutMs: 25 });
    await client.call('settings.get', {});
  })().then(() => 'resolved', error => String(error));
  try {
    expect(await Promise.race([result, Bun.sleep(300).then(() => 'still pending')])).toContain('timed out');
    if (phase === 'hello') {
      for (let i = 0; i < 20 && !closed; i++) await Bun.sleep(5);
      expect(closed).toBe(true);
    }
  } finally { client?.close(); void server.stop(true); await result; }
});

test.each(['hello', 'call'] as const)('client reports peer close code and bounded reason during %s', async phase => {
  const reason = 'slow peer\n' + 'x'.repeat(100);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, self) { return self.upgrade(request) ? undefined : new Response('upgrade required'); },
    websocket: { message(socket, raw) {
      const frame = JSON.parse(String(raw));
      if (phase === 'call' && frame.method === 'hello') socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { core: { protocolVersion: PROTOCOL_VERSION }, principal: 'owner' } }));
      else socket.close(1013, reason);
    } },
  });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const closed = (async () => {
      client = await connect(`http://127.0.0.1:${server.port}`, 'test');
      const watching = client.next('core.log').catch(error => error as Error);
      const failed = await client.call('settings.get', {}).catch(error => error as Error);
      expect((await watching).message).toContain('1013');
      return failed;
    })().catch(error => error as Error);
    const error = await closed as Error & { code: number; reason: string };
    expect(error.message).toContain('the socket closed (1013');
    expect(error.code).toBe(1013);
    expect(error.reason.length).toBeLessThanOrEqual(80);
    expect(error.message).toContain('slow peer\\n');
    expect(error.message).not.toContain('\n');
  } finally { client?.close(); void server.stop(true); }
});

/** A core that answers hello, and every call with `{ ok: true }` after a `core.log` event. */
function answeringCore() {
  return Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, self) { return self.upgrade(request) ? undefined : new Response('upgrade required'); },
    websocket: { message(socket, raw) {
      const frame = JSON.parse(String(raw));
      if (frame.method !== 'hello') socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'core.log', params: {} }));
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id,
        result: frame.method === 'hello' ? { core: { protocolVersion: PROTOCOL_VERSION }, principal: 'owner' } : { ok: true } }));
    } },
  });
}

test('a call whose params do not serialize rejects and leaves no timer behind', async () => {
  const server = answeringCore();
  const client = await connect(`http://127.0.0.1:${server.port}`, 'test', { requestTimeoutMs: 123_456 });
  const live = new Set<unknown>();
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], timeout?: number, ...args: unknown[]) => {
    const timer = set(handler, timeout, ...args);
    if (timeout === 123_456) live.add(timer);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => { live.delete(timer); clear(timer); }) as typeof clearTimeout;
  try {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(client.call('settings.get', cyclic as never)).rejects.toThrow();
    expect(live.size).toBe(0);
  } finally {
    globalThis.setTimeout = set;
    globalThis.clearTimeout = clear;
    client.close();
    await server.stop(true);
  }
});

test('an event handler that throws is reported and the answer behind it still arrives', async () => {
  const server = answeringCore();
  const client = await connect(`http://127.0.0.1:${server.port}`, 'test', { requestTimeoutMs: 2_000 });
  const report = globalThis.reportError;
  const reported: unknown[] = [];
  globalThis.reportError = (error) => { reported.push(error); };
  try {
    client.on('core.log', () => { throw new Error('a subscriber failed'); });
    expect(await client.call('settings.get', {} as never) as unknown).toEqual({ ok: true });
    expect(reported.map((error) => (error as Error).message)).toEqual(['a subscriber failed']);
  } finally {
    globalThis.reportError = report;
    client.close();
    await server.stop(true);
  }
});
