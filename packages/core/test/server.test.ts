import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PROTOCOL_VERSION, RPC_PATH, RpcCloseCode, RpcErrorCode } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { Core } from '../src/core.ts';
import { newToken } from '../src/ids.ts';
import { pair } from '../src/main.ts';
import { isAllowedOrigin, PLACEHOLDER_HTML, ServerConnection, startServer, UI_DIST } from '../src/server.ts';
import { removeDir, startTestCore } from './harness.ts';
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

  test('shutdown takes a POST with the core token, and an embedded core says it cannot stop', async () => {
    const at = `${harness.url}/shutdown`;
    expect((await fetch(at)).status).toBe(405);
    expect((await fetch(at, { method: 'POST' })).status).toBe(401);
    expect((await fetch(at, { method: 'POST', headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    // A proxy on this machine forwards a public name: the route is not for it.
    const proxied = await fetch(at, { method: 'POST', headers: { authorization: `Bearer ${harness.token}`, host: 'boite.example' } });
    expect(proxied.status).toBe(403);
    // The harness core has no process of its own to stop.
    expect((await fetch(at, { method: 'POST', headers: { authorization: `Bearer ${harness.token}` } })).status).toBe(501);
  });

  test('shutdown with the core token stops a core that owns its process', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'boite-shutdown-'));
    let stopped = 0;
    const token = newToken();
    const core = new Core({ dataDir, token, onShutdown: () => { stopped += 1; } });
    const server = startServer({ core, host: '127.0.0.1', port: 0 });
    try {
      const ask = () => fetch(`${server.url}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      const first = await ask();
      expect(first.status).toBe(202);
      expect(((await first.json()) as { pid: number }).pid).toBe(process.pid);
      // A second request while the first is draining is not a second stop.
      expect((await ask()).status).toBe(202);
      await Bun.sleep(60);
      expect(stopped).toBe(1);
    } finally {
      await server.stop();
      await core.close();
      await removeDir(dataDir);
    }
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

  test('a pairing grant is exchanged once for a session that survives a restart, and a revoke closes it', async () => {
    const owner = await harness.connect();
    expect(owner.principal).toBe('owner');
    const { url, grant, expiresAt } = await owner.call('pairing.grant', {});
    expect(url).toBe(`${harness.url}/?grant=${grant}`);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(owner.core).not.toHaveProperty('pairingUrl');

    const phone = await connect(harness.url, '', { grant, client: { name: 'pwa', version: '2.0.0-beta.1' } });
    expect(phone.principal).toBe('session');
    expect(phone.session?.token).toHaveLength(64);
    expect(phone.session?.token).not.toBe(harness.token);
    expect(await phone.call('projects.list', {})).toEqual([]);

    // Second use of the same link: refused by name, socket closed.
    let reused = 'none';
    try {
      await connect(harness.url, '', { grant });
    } catch (error) {
      reused = (error as Error).message;
    }
    expect(reused).toBe('the pairing link was already used, expired, or never issued');

    // The session token opens the RPC on its own, and the journal holds only its hash.
    const again = await connect(harness.url, phone.session?.token ?? '');
    expect(again.principal).toBe('session');
    const rows = harness.core.journal.listSessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toContain(phone.session?.token ?? 'never');
    expect(rows[0]?.client_name).toBe('pwa');

    // A session sees the list with itself marked, and cannot mint or revoke.
    const seen = await again.call('sessions.list', {});
    expect(seen.map((row) => row.current)).toEqual([true]);
    let minted = 'none';
    try {
      await again.call('pairing.grant', {});
    } catch (error) {
      minted = (error as Error).message;
    }
    expect(minted).toBe('pairing.grant is for the owner only');

    // Revoked by the owner: both of its sockets close 4001 and the token is dead.
    const sessionId = phone.session?.id ?? '';
    const closed = new Promise<void>((resolve) => again.on('core.log', () => resolve()));
    await owner.call('sessions.revoke', { sessionId });
    void closed;
    expect(await owner.call('sessions.list', {})).toEqual([]);
    let dead = 'none';
    try {
      await connect(harness.url, phone.session?.token ?? '');
    } catch (error) {
      dead = (error as Error).message;
    }
    expect(dead).toBe('the token is wrong');
    let after = 'none';
    try {
      await again.call('projects.list', {});
    } catch (error) {
      after = (error as Error).message;
    }
    expect(['the socket closed', 'the client is closed']).toContain(after);
  });

  test('an owner pairing link becomes a key that drives the core as its owner, until it is revoked', async () => {
    const owner = await harness.connect();
    const minted = await owner.call('pairing.grant', { role: 'owner' });
    expect(minted.role).toBe('owner');

    const laptop = await connect(harness.url, '', { grant: minted.grant, client: { name: 'shell', version: '2.0.0-beta.1' } });
    expect(laptop.principal).toBe('owner');
    expect(laptop.session?.token).toHaveLength(64);
    expect(laptop.session).not.toHaveProperty('role');

    // The key alone says hello as the owner, reaches what a phone is refused,
    // and is still a row the owner sees and can take away.
    const again = await connect(harness.url, laptop.session?.token ?? '');
    expect(again.principal).toBe('owner');
    const phoneLink = await again.call('pairing.grant', {});
    expect(phoneLink.role).toBe('device');
    const rows = await owner.call('sessions.list', {});
    expect(rows.map((row) => [row.role, row.client.name])).toEqual([['owner', 'shell']]);
    expect(harness.core.journal.listSessions()[0]?.role).toBe('owner');

    await owner.call('sessions.revoke', { sessionId: laptop.session?.id ?? '' });
    let dead = 'none';
    try {
      await connect(harness.url, laptop.session?.token ?? '');
    } catch (error) {
      dead = (error as Error).message;
    }
    expect(dead).toBe('the token is wrong');
  });

  test('pairing.grant refuses a role it does not know, by name', async () => {
    const owner = await harness.connect();
    let refused = 'none';
    try {
      await owner.call('pairing.grant', { role: 'admin' as 'owner' });
    } catch (error) {
      refused = (error as Error).message;
    }
    expect(refused).toBe('pairing.grant role must be device or owner, got admin');
  });

  test('boite-core pair reads core.json and hands back a link of the role asked for', async () => {
    let missing = 'none';
    try {
      await pair(['--data-dir', harness.dataDir]);
    } catch (error) {
      missing = (error as Error).message;
    }
    expect(missing).toContain('core.json does not exist');

    const port = Number(new URL(harness.url).port);
    const state = { port, host: '0.0.0.0', token: harness.token, pid: process.pid, startedAt: Date.now(), version: 'test' };
    writeFileSync(join(harness.dataDir, 'core.json'), JSON.stringify(state));
    const ownerLink = await pair(['--owner', '--data-dir', harness.dataDir]);
    expect(ownerLink.role).toBe('owner');
    expect(ownerLink.url).toBe(`${harness.url}/?grant=${ownerLink.grant}`);
    const laptop = await connect(harness.url, '', { grant: ownerLink.grant, client: { name: 'shell', version: '0' } });
    expect(laptop.principal).toBe('owner');

    const phoneLink = await pair(['--data-dir', harness.dataDir]);
    expect(phoneLink.role).toBe('device');
  });

  test('a grant expires, and hello with both a token and a grant is refused', async () => {
    const grant = harness.core.sessions.grant(1_000);
    let expired = 'none';
    try {
      harness.core.sessions.exchange(grant.grant, { name: 'pwa', version: '0' }, 1_000 + 10 * 60 * 1000);
    } catch (error) {
      expired = (error as Error).message;
    }
    expect(expired).toBe('the pairing link was already used, expired, or never issued');

    const socket = rawSocket();
    await opened(socket);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: {
      token: harness.token, grant: 'x', protocolVersion: PROTOCOL_VERSION, client: { name: 'test', version: '0' },
    } }));
    const frame = (await firstFrame(socket)) as { error?: { code: number; message: string } };
    expect(frame.error?.message).toBe('hello takes a token or a grant, one of the two');
    expect(await closeCode(socket)).toBe(RpcCloseCode.Unauthorized);
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
