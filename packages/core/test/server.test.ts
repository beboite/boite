import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { RPC_PATH, RpcCloseCode, RpcErrorCode } from '@boite/contracts';
import { PLACEHOLDER_HTML, UI_DIST } from '../src/server.ts';
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
    expect(client.core.protocolVersion).toBe(1);
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
