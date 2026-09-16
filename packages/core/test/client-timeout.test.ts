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
