import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PROTOCOL_VERSION, RPC_PATH, RpcCloseCode, RpcErrorCode } from '@boite/contracts';
import { isAllowedOrigin, PLACEHOLDER_HTML, ServerConnection, UI_DIST } from '../src/server.ts';
import { startTestCore } from './harness.ts';
import type { TestCore } from './harness.ts';

const HELLO_TIMEOUT_MS = 200;

let harness: TestCore;

beforeEach(async () => {
  harness = await startTestCore({ helloTimeoutMs: HELLO_TIMEOUT_MS });
});

afterEach(async () => {
  await harness.stop();
});

function rawSocket(): WebSocket {
  return new WebSocket(harness.url.replace('http', 'ws') + RPC_PATH);
}

function closeCode(socket: WebSocket, timeoutMs = 3000): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the socket never closed')), timeoutMs);
    socket.addEventListener('close', (event: CloseEvent) => {
      clearTimeout(timer);
      resolve(event.code);
    });
  });
}

function firstFrame(socket: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no frame arrived')), timeoutMs);
    socket.addEventListener('message', (event: MessageEvent) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
    });
  });
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('the socket failed to open')));
  });
}

describe('server', () => {
  test('drain sends the journal including deltas still inside the coalescing window', () => {
    const journal = harness.core.journal;
    journal.putMessage({ id: 'msg_drain', threadId: 'thr_drain', turnId: 'turn_drain', role: 'assistant',
      state: 'streaming', createdAt: Date.now(), parts: [] });
    const writes: string[] = [];
    const closed: number[] = [];
    let result = -1;
    const connection = new ServerConnection(harness.core);
    connection.attach({ send: (frame: string) => { writes.push(frame); return result; },
      close: (code: number) => { closed.push(code); } } as unknown as Parameters<ServerConnection['attach']>[0]);
    const delta = { threadId: 'thr_drain', messageId: 'msg_drain', partIndex: 0, text: 'first' };
    journal.appendDelta(delta.threadId, delta.messageId, 0, delta.text);
    connection.sendEvent('message.delta', delta);
    journal.appendDelta(delta.threadId, delta.messageId, 0, ' second');
    connection.sendEvent('message.delta', { ...delta, text: ' second' });
    expect(writes).toHaveLength(1);
    result = 20;
    connection.drain();
    expect(JSON.parse(writes[1] ?? '{}').params.part.text).toBe('first second');
    expect(closed).toEqual([]);
    result = 0;
    connection.sendEvent('message.delta', delta);
    expect(closed).toEqual([1013]);
  });
  test('a valid token with an incompatible protocol closes 4010', async () => {
    const socket = rawSocket();
    await opened(socket);
    const closed = closeCode(socket);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: {
      token: harness.token, protocolVersion: PROTOCOL_VERSION - 1, client: { name: 'test', version: '0' },
    } }));
    expect(await closed).toBe(RpcCloseCode.ProtocolMismatch);
  });
  test('LAN origin checks reject foreign hosts and opaque origins', () => {
    for (const origin of ['null', '', 'http://evil.example:4321', 'https://evil.example:4321']) {
      expect(isAllowedOrigin(origin, 4321, '0.0.0.0')).toBe(false);
    }
    expect(isAllowedOrigin(null, 4321, '0.0.0.0')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:4321', 4321, '0.0.0.0')).toBe(true);
    expect(isAllowedOrigin('tauri://localhost', 4321, '0.0.0.0')).toBe(true);
    expect(isAllowedOrigin('http://192.0.2.1:4321', 4321, '192.0.2.1')).toBe(true);
    expect(isAllowedOrigin('http://192.0.2.1:4322', 4321, '192.0.2.1')).toBe(false);
  });
  test('health answers without auth', async () => {
    const response = await fetch(`${harness.url}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; version: string; pid: number };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(harness.core.version);
    expect(body.pid).toBe(process.pid);
  });

  test('the root serves the UI build, or the placeholder when there is none', async () => {
    expect(PLACEHOLDER_HTML).toContain('Boite core is running; the UI is not built');
    const response = await fetch(`${harness.url}/`);
    expect(response.status).toBe(200);
    const body = await response.text();
    if (existsSync(UI_DIST)) expect(body).toContain('<html');
    else expect(body).toBe(PLACEHOLDER_HTML);
  });

  // Without `bun run build:ui` there is nothing to serve and nothing to assert;
  // the end to end suite builds the UI before it starts, and proves the same three.
  test.skipIf(!existsSync(UI_DIST))(
    'the shell, the worker and a hashed asset carry the headers the PWA needs',
    async () => {
      const index = await fetch(`${harness.url}/`);
      expect(index.status).toBe(200);
      expect(index.headers.get('cache-control')).toBe('no-cache');
      const html = await index.text();

      const worker = await fetch(`${harness.url}/sw.js`);
      expect(worker.status).toBe(200);
      expect(worker.headers.get('cache-control')).toBe('no-cache');
      // Without it a worker served from `/sw.js` may only claim `/`, which is
      // the same scope here, but the header is what makes that explicit.
      expect(worker.headers.get('service-worker-allowed')).toBe('/');

      const manifest = await fetch(`${harness.url}/manifest.webmanifest`);
      expect(manifest.status).toBe(200);
      expect(manifest.headers.get('cache-control')).toBe('no-cache');

      // The hashed name is read out of the build rather than guessed.
      const hashed = /assets\/[A-Za-z0-9._-]+/.exec(html)?.[0];
      expect(hashed).toBeDefined();
      const asset = await fetch(`${harness.url}/${hashed}`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    },
  );

  test('a foreign origin gets 403', async () => {
    const response = await fetch(`${harness.url}${RPC_PATH}`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(response.status).toBe(403);
  });

  test('no hello inside the window closes 4001', async () => {
    const socket = rawSocket();
    await opened(socket);
    expect(await closeCode(socket)).toBe(RpcCloseCode.Unauthorized);
  });

  test('a wrong token closes 4001', async () => {
    const socket = rawSocket();
    await opened(socket);
    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'hello',
        params: { token: 'not-the-token', client: { name: 'test', version: '0' } },
      }),
    );
    const frame = (await firstFrame(socket)) as { error?: { code: number } };
    expect(frame.error?.code).toBe(RpcErrorCode.Unauthorized);
    expect(await closeCode(socket)).toBe(RpcCloseCode.Unauthorized);
  });

  test('a frame before hello is refused', async () => {
    const socket = rawSocket();
    await opened(socket);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'projects.list', params: {} }));
    const frame = (await firstFrame(socket)) as { error?: { code: number } };
    expect(frame.error?.code).toBe(RpcErrorCode.Unauthorized);
    expect(await closeCode(socket)).toBe(RpcCloseCode.Unauthorized);
  });

  test('the right token opens the RPC', async () => {
    const client = await harness.connect();
    expect(client.core.pid).toBe(process.pid);
    expect(client.core.protocolVersion).toBe(PROTOCOL_VERSION);
    // A core nobody told otherwise is the stable install.
    expect(client.core.channel).toBe('stable');
    expect(await client.call('projects.list', {})).toEqual([]);
  });

  test('an unknown method answers MethodNotFound', async () => {
    const client = await harness.connect();
    let failure = 'none';
    try {
      await client.call('does.not.exist' as 'projects.list', {} as Record<string, never>);
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toContain('unknown method');
  });
});
