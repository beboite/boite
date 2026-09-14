import { describe, expect, test, vi } from 'vitest';
import { PROTOCOL_VERSION, RpcCloseCode, RpcErrorCode, type CoreInfo } from '@boite/contracts';
import { RpcFailure, WsClient, rpcUrl, type SocketLike } from './client';

const CORE: CoreInfo = {
  version: '2.0.0-beta.1',
  protocolVersion: PROTOCOL_VERSION,
  os: 'windows',
  channel: 'stable',
  pid: 99,
  startedAt: 0,
  endpoint: { host: '127.0.0.1', port: 8777 },
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
  onclose: SocketLike['onclose'] = null;
  onerror: (() => void) | null = null;
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closed = true;
    this.onclose?.({ code });
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
      protocolVersion: PROTOCOL_VERSION,
      client: { name: 'shell', version: '2.0.0-beta.1' }
    });

    live.receive({ jsonrpc: '2.0', id: hello.id, result: { core: CORE, principal: 'owner' } });
    await expect(connecting).resolves.toEqual(CORE);
    expect(client.state).toBe('ready');
    expect(client.core).toEqual(CORE);
    expect(client.principal).toBe('owner');
  });

  test('a grant goes out on the first hello, and the session that comes back is the token from then on', async () => {
    const sockets: FakeSocket[] = [];
    const stored: { id: string; token: string }[] = [];
    const client = new WsClient({
      url: 'http://127.0.0.1:8777',
      token: '',
      grant: 'one-time',
      onSession: (session) => stored.push(session),
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
    expect(first.frame(0).params).toMatchObject({ grant: 'one-time' });
    expect(first.frame(0).params).not.toHaveProperty('token');
    first.receive({
      jsonrpc: '2.0',
      id: first.frame(0).id,
      result: { core: CORE, principal: 'session', session: { id: 'ses-1', token: 'minted' } }
    });
    await Promise.resolve();
    expect(client.principal).toBe('session');
    expect(stored).toEqual([{ id: 'ses-1', token: 'minted' }]);

    // The reconnect says hello with the minted token, never with the grant again.
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = take(sockets, 1);
    second.open();
    expect(second.frame(0).params).toMatchObject({ token: 'minted' });
    expect(second.frame(0).params).not.toHaveProperty('grant');
    client.close();
  });

  test('a session whose key stops opening the core is revoked: closed for good, and the caller told', async () => {
    const sockets: FakeSocket[] = [];
    let revoked = 0;
    const client = new WsClient({
      url: 'http://127.0.0.1:8777',
      token: 'minted',
      onRevoked: () => {
        revoked += 1;
      },
      backoff: () => 0,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }
    });
    void client.connect().catch(() => undefined);
    const first = take(sockets, 0);
    first.open();
    first.receive({ jsonrpc: '2.0', id: first.frame(0).id, result: { core: CORE, principal: 'session' } });
    await Promise.resolve();
    expect(client.principal).toBe('session');

    // The core closes the socket on the revoke; the reconnect's hello is refused.
    first.close(RpcCloseCode.Unauthorized);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = take(sockets, 1);
    second.open();
    second.receive({ jsonrpc: '2.0', id: second.frame(0).id, error: { code: RpcErrorCode.Unauthorized, message: 'the token is wrong' } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(revoked).toBe(1);
    expect(client.state).toBe('closed');
    expect(sockets).toHaveLength(2);
  });

  test('a paired key that speaks as the owner is still revoked when it stops opening the core', async () => {
    const sockets: FakeSocket[] = [];
    let revoked = 0;
    const client = new WsClient({
      url: 'http://127.0.0.1:8777',
      token: 'minted',
      paired: true,
      onRevoked: () => {
        revoked += 1;
      },
      backoff: () => 0,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }
    });
    void client.connect().catch(() => undefined);
    const first = take(sockets, 0);
    first.open();
    first.receive({ jsonrpc: '2.0', id: first.frame(0).id, result: { core: CORE, principal: 'owner' } });
    await Promise.resolve();
    expect(client.principal).toBe('owner');

    first.close(RpcCloseCode.Unauthorized);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = take(sockets, 1);
    second.open();
    second.receive({ jsonrpc: '2.0', id: second.frame(0).id, error: { code: RpcErrorCode.Unauthorized, message: 'the token is wrong' } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(revoked).toBe(1);
    expect(client.state).toBe('closed');
  });

  test('a grant the core refuses closes the client for good', async () => {
    const sockets: FakeSocket[] = [];
    const client = new WsClient({
      url: 'http://127.0.0.1:8777',
      token: '',
      grant: 'spent',
      backoff: () => 0,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }
    });
    const connecting = client.connect();
    const rejection = expect(connecting).rejects.toThrow('already used');
    const socket = take(sockets, 0);
    socket.open();
    socket.receive({
      jsonrpc: '2.0',
      id: socket.frame(0).id,
      error: { code: RpcErrorCode.Unauthorized, message: 'the pairing link was already used, expired, or never issued' }
    });
    await rejection;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(client.state).toBe('closed');
    expect(sockets).toHaveLength(1);
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

test('a permanent protocol rejection closes the client without reconnecting', async () => {
  vi.useFakeTimers();
  const sockets: FakeSocket[] = [];
  const client = new WsClient({
    url: 'http://127.0.0.1:8777', token: 'secret', backoff: () => 1,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }
  });
  try {
    const connecting = client.connect();
    const rejection = expect(connecting).rejects.toThrow('protocolVersion must be');
    const socket = take(sockets, 0);
    socket.open();
    socket.receive({ jsonrpc: '2.0', id: socket.frame(0).id, error: {
      code: RpcErrorCode.InvalidParams, message: `protocolVersion must be ${PROTOCOL_VERSION + 1}`
    } });
    await Promise.resolve();
    socket.close(RpcCloseCode.ProtocolMismatch);
    await rejection;
    await vi.advanceTimersByTimeAsync(100);
    expect(client.state).toBe('closed');
    expect(sockets).toHaveLength(1);
  } finally {
    client.close();
    vi.useRealTimers();
  }
});
