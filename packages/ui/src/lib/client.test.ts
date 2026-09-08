import { describe, expect, test } from 'vitest';
import { RpcErrorCode, type CoreInfo } from '@boite/contracts';
import { RpcFailure, WsClient, rpcUrl, type SocketLike } from './client';

const CORE: CoreInfo = {
  version: '2.0.0-beta.1',
  protocolVersion: 1,
  os: 'windows',
  pid: 99,
  startedAt: 0,
  endpoint: { host: '127.0.0.1', port: 8777 },
  pairingUrl: 'http://127.0.0.1:8777/',
  dataDir: 'C:\\boite2',
  trace: { os: 'windows', mode: 'events', note: 'exact' }
};

interface Frame {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

class FakeSocket implements SocketLike {
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  open(): void {
    this.onopen?.();
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  frame(index: number): Frame {
    const raw = this.sent[index];
    if (raw === undefined) throw new Error(`no frame at ${index}`);
    return JSON.parse(raw) as Frame;
  }
}

function take(sockets: FakeSocket[], index: number): FakeSocket {
  const socket = sockets[index];
  if (!socket) throw new Error(`no socket at ${index}`);
  return socket;
}

function connected(): { client: WsClient; socket: FakeSocket; urls: string[] } {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const client = new WsClient({
    url: 'http://127.0.0.1:8777',
    token: 'secret',
    socketFactory: (target) => {
      urls.push(target);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    reconnect: false
  });
  void client.connect().catch(() => undefined);
  return { client, socket: take(sockets, 0), urls };
}

describe('rpcUrl', () => {
  test('points at the RPC path over ws', () => {
    expect(rpcUrl('http://127.0.0.1:8777')).toBe('ws://127.0.0.1:8777/rpc');
    expect(rpcUrl('https://box.local/')).toBe('wss://box.local/rpc');
  });
});

describe('WsClient', () => {
  test('hello is the first frame, and it carries the token', async () => {
    const sockets: FakeSocket[] = [];
    const client = new WsClient({
      url: 'http://127.0.0.1:8777',
      token: 'secret',
      clientName: 'shell',
      version: '2.0.0-beta.1',
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnect: false
    });
    const connecting = client.connect();
    const live = take(sockets, 0);

    expect(live.sent).toHaveLength(0);
    live.open();

    const hello = live.frame(0);
    expect(hello.method).toBe('hello');
    expect(hello.params).toEqual({
      token: 'secret',
      client: { name: 'shell', version: '2.0.0-beta.1' }
    });

    live.receive({ jsonrpc: '2.0', id: hello.id, result: { core: CORE } });
    await expect(connecting).resolves.toEqual(CORE);
    expect(client.state).toBe('ready');
    expect(client.core).toEqual(CORE);
  });

  test('a response resolves the matching call', async () => {
    const { client, socket } = connected();
    socket.open();
    socket.receive({ jsonrpc: '2.0', id: socket.frame(0).id, result: { core: CORE } });
    await Promise.resolve();

    const pending = client.call('threads.list', {});
    const request = socket.frame(1);
    expect(request.method).toBe('threads.list');

    socket.receive({ jsonrpc: '2.0', id: request.id, result: [] });
    await expect(pending).resolves.toEqual([]);
  });

  test('a notification reaches its handler', async () => {
    const { client, socket } = connected();
    socket.open();
    socket.receive({ jsonrpc: '2.0', id: socket.frame(0).id, result: { core: CORE } });
    await Promise.resolve();

    const seen: string[] = [];
    const off = client.on('core.log', (entry) => seen.push(entry.message));
    socket.receive({
      jsonrpc: '2.0',
      method: 'core.log',
      params: { level: 'info', message: 'ready', at: 1 }
    });
    expect(seen).toEqual(['ready']);

    off();
    socket.receive({
      jsonrpc: '2.0',
      method: 'core.log',
      params: { level: 'info', message: 'again', at: 2 }
    });
    expect(seen).toEqual(['ready']);
  });

  test('an error frame rejects with the code the core sent', async () => {
    const { client, socket } = connected();
    socket.open();
    socket.receive({ jsonrpc: '2.0', id: socket.frame(0).id, result: { core: CORE } });
    await Promise.resolve();

    const pending = client.call('threads.get', { threadId: 'nope' });
    const request = socket.frame(1);
    socket.receive({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: RpcErrorCode.NotFound, message: 'no such thread: nope', data: { id: 'nope' } }
    });

    await expect(pending).rejects.toBeInstanceOf(RpcFailure);
    await pending.catch((error: unknown) => {
      const failure = error as RpcFailure;
      expect(failure.code).toBe(RpcErrorCode.NotFound);
      expect(failure.message).toBe('no such thread: nope');
      expect(failure.data).toEqual({ id: 'nope' });
    });
  });

  test('the subscribed thread is subscribed again after a reconnect', async () => {
    const sockets: FakeSocket[] = [];
    const client = new WsClient({
      url: 'http://127.0.0.1:8777',
      token: 'secret',
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      backoff: () => 0
    });
    void client.connect().catch(() => undefined);
    const first = take(sockets, 0);
    first.open();
    first.receive({ jsonrpc: '2.0', id: first.frame(0).id, result: { core: CORE } });
    await Promise.resolve();

    const subscribing = client.call('threads.subscribe', { threadId: 't-1' });
    first.receive({ jsonrpc: '2.0', id: first.frame(1).id, result: { ok: true } });
    await subscribing;

    first.close();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = take(sockets, 1);
    second.open();
    second.receive({ jsonrpc: '2.0', id: second.frame(0).id, result: { core: CORE } });
    await Promise.resolve();
    await Promise.resolve();

    expect(second.frame(1).method).toBe('threads.subscribe');
    expect(second.frame(1).params).toEqual({ threadId: 't-1' });
    client.close();
  });
});
