import { expect, test } from 'bun:test';
import { rpcTrace } from './fixtures/journal-rpc-trace.ts';
import type { CoreClient } from '../src/client.ts';
import { startTestCore, type TestCore } from './harness.ts';
import { ServerConnection } from '../src/server/connection.ts';

test('diagnostics retain the final native close after a full ring without recording credentials or peer reason', async () => {
  const originalSend = WebSocket.prototype.send;
  const trace = rpcTrace({ methods: ['hello', 'threads.list'] });
  let harness: TestCore | undefined, owner: CoreClient | undefined;
  try {
    harness = await startTestCore();
    owner = await harness.connect();
    for (let i = 0; i < 20; i++) await owner.call('threads.list', {});
    const server = Bun.serve({ port: 0, fetch(request, server) { if (server.upgrade(request)) return; return new Response('', { status: 400 }); }, websocket: { open(socket) { socket.close(1013, 'PRIVATE_REASON'); }, message() {} } });
    try {
      const native = new WebSocket(`ws://127.0.0.1:${server.port}`);
      await new Promise<void>(resolve => native.addEventListener('close', () => resolve()));
    } finally { await server.stop(true); }
    const connection = new ServerConnection(harness.core);
    connection.close(1013, 'PRIVATE_REASON');
    const events = trace.snapshot();
    expect(events).toHaveLength(64);
    expect(events.some(event => event.hop === 'server.close' && event.code === 1013)).toBe(true);
    expect(events.some(event => event.hop === 'client.close' && event.code === 1013)).toBe(true);
    expect(events.some(event => event.role === 'owner')).toBe(true);
    expect(events.every(event => typeof event.wallTiming === 'number')).toBe(true);
    const encoded = JSON.stringify(events);
    expect(encoded).not.toContain('PRIVATE_REASON');
    expect(encoded).not.toContain(harness.token);
  } finally {
    try { owner?.close(); await harness?.stop(); } finally { trace.restore(); }
  }
  expect(WebSocket.prototype.send).toBe(originalSend);
});
