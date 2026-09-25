import { describe, expect, test, vi } from 'vitest';
import { PROTOCOL_VERSION, RPC_MAX_FRAME_BYTES, RpcCloseCode, RpcErrorCode, type CoreInfo } from '@boite/contracts';
import { RpcFailure, WsClient, defaultBackoff, openDeadline, rpcUrl, type SocketLike } from './client';

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

describe('reconnect timing', () => {
  test('the backoff doubles to 10 s with 20 % jitter either way', () => {
    expect([0, 1, 2, 3, 4, 9].map((attempt) => defaultBackoff(attempt, () => 0.5))).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000]);
    expect(defaultBackoff(0, () => 0)).toBe(800);
    expect(defaultBackoff(9, () => 1)).toBe(12_000);
  });

  test('an attempt gets 10 s, then 20 s, then 30 s to answer', async () => {
    expect([0, 1, 2, 5].map(openDeadline)).toEqual([10_000, 20_000, 30_000, 30_000]);
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = new WsClient({ url: 'https://core.test', token: 'secret', backoff: () => 0, socketFactory: () => {
      const socket = new FakeSocket(); sockets.push(socket); return socket;
    } });
    try {
      const first = client.connect().catch((error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await first).toBe('connection did not answer within 10 seconds');
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(19_000);
      expect(take(sockets, 1).closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(take(sockets, 1).closed).toBe(true);
    } finally { client.close(); vi.useRealTimers(); }
  });

  test('offline, a remote client waits for the online event instead of retrying', async () => {
    vi.useFakeTimers();
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const sockets: FakeSocket[] = [];
    const client = new WsClient({ url: 'https://core.test', token: 'secret', backoff: () => 1_000, socketFactory: () => {
      const socket = new FakeSocket(); sockets.push(socket); return socket;
    } });
    try {
      void client.connect().catch(() => undefined);
      take(sockets, 0).close();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets).toHaveLength(1);
      expect(client.state).toBe('connecting');

      online.mockReturnValue(true);
      void client.resume().catch(() => undefined);
      expect(sockets).toHaveLength(2);
    } finally { online.mockRestore(); client.close(); vi.useRealTimers(); }
  });

  test('offline, a loopback client keeps retrying: its core is on this machine', async () => {
    vi.useFakeTimers();
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const sockets: FakeSocket[] = [];
    const client = new WsClient({ url: 'http://127.0.0.1:8777', token: 'secret', backoff: () => 1_000, socketFactory: () => {
      const socket = new FakeSocket(); sockets.push(socket); return socket;
    } });
    try {
      void client.connect().catch(() => undefined);
      take(sockets, 0).close();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sockets).toHaveLength(2);
    } finally { online.mockRestore(); client.close(); vi.useRealTimers(); }
  });
});

describe('rpcUrl', () => {
  test('points at the RPC path over ws', () => {
    expect(rpcUrl('http://127.0.0.1:8777')).toBe('ws://127.0.0.1:8777/rpc');
    expect(rpcUrl('https://box.local/')).toBe('wss://box.local/rpc');
  });
});

describe('WsClient', () => {
  test('a silent RPC expires without resending it, and a probe the core answers keeps the connection', async () => {
    vi.useFakeTimers();
    const { client, socket } = connected();
    try {
      socket.open();
      socket.receive({ id: socket.frame(0).id, result: { core: CORE, principal: 'owner' } });
      await client.connect();
      let failure: unknown;
      const pending = client.call('turns.start', { threadId: 'thread', prompt: 'once' }).catch(error => { failure = error; });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(failure).toBeInstanceOf(RpcFailure);
      expect((failure as Error).message).toContain('timed out');
      // Never resent; the timeout asks the socket whether anything is still there.
      expect(socket.sent.map(raw => JSON.parse(raw).method)).toEqual(['hello', 'turns.start', 'hello']);
      socket.receive({ id: socket.frame(2).id, result: { core: CORE, principal: 'owner' } });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(client.state).toBe('ready');
      expect(socket.closed).toBe(false);
      await pending;
      // A late response cannot settle a subsequent request with another id.
      socket.receive({ id: socket.frame(1).id, result: {} });
      const next = client.call('projects.list', {});
      socket.receive({ id: socket.frame(3).id, result: [] });
      expect(await next).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { client.close(); vi.useRealTimers(); }
  });

  test('a call that times out on a dead socket replaces the socket', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = new WsClient({ url: 'http://127.0.0.1:8777', token: 'secret', backoff: () => 0, socketFactory: () => {
      const socket = new FakeSocket(); sockets.push(socket); return socket;
    } });
    try {
      void client.connect();
      const first = take(sockets, 0);
      first.open();
      first.receive({ id: first.frame(0).id, result: { core: CORE, principal: 'owner' } });
      await client.connect();
      const pending = client.call('turns.start', { threadId: 'thread', prompt: 'once' }).catch((error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(120_000 + 15_000);
      expect(await pending).toContain('timed out');
      expect(first.closed).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(2);
      expect(client.state).toBe('connecting');
    } finally { client.close(); vi.useRealTimers(); }
  });

  test('a remote socket that goes silent is probed, then replaced when nothing comes back', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const states: string[] = [];
    const client = new WsClient({ url: 'https://core.test', token: 'session', backoff: () => 1_000, socketFactory: () => {
      const socket = new FakeSocket(); sockets.push(socket); return socket;
    } });
    client.onState((state) => states.push(state));
    try {
      void client.connect();
      const first = take(sockets, 0);
      first.open();
      first.receive({ id: first.frame(0).id, result: { core: CORE, principal: 'session' } });
      await client.connect();
      let failure = '';
      void client.call('threads.list', {}).catch((error: Error) => { failure = error.message; });

      await vi.advanceTimersByTimeAsync(25_000);
      expect(first.sent.map(raw => JSON.parse(raw).method)).toEqual(['hello', 'threads.list', 'hello']);
      expect(client.state).toBe('ready');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(first.closed).toBe(true);
      expect(failure).toBe('connection lost; check the conversation before resending');
      expect(states).toEqual(['connecting', 'ready', 'connecting']);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sockets).toHaveLength(2);
    } finally { client.close(); vi.useRealTimers(); }
  });

  test('a remote socket that keeps receiving is never probed, and a loopback one never at all', async () => {
    vi.useFakeTimers();
    const run = async (url: string, chatty: boolean): Promise<string[]> => {
      const sockets: FakeSocket[] = [];
      const client = new WsClient({ url, token: 'secret', socketFactory: () => {
        const socket = new FakeSocket(); sockets.push(socket); return socket;
      } });
      void client.connect();
      const socket = take(sockets, 0);
      socket.open();
      socket.receive({ id: socket.frame(0).id, result: { core: CORE, principal: 'owner' } });
      await client.connect();
      for (let second = 0; second < 120; second += 1) {
        if (chatty && second % 10 === 0) socket.receive({ method: 'core.log', params: { level: 'info', message: 'tick', at: second } });
        await vi.advanceTimersByTimeAsync(1_000);
      }
      const methods = socket.sent.map(raw => JSON.parse(raw).method as string);
      expect(socket.closed).toBe(false);
      expect(sockets).toHaveLength(1);
      client.close();
      return methods;
    };
    try {
      expect(await run('https://core.test', true)).toEqual(['hello']);
      expect(await run('http://127.0.0.1:8777', false)).toEqual(['hello']);
    } finally { vi.useRealTimers(); }
  });

  test('a synchronous send failure does not leave a pending request or timer', async () => {
    vi.useFakeTimers();
    const { client, socket } = connected();
    try {
      socket.open();
      socket.receive({ id: socket.frame(0).id, result: { core: CORE, principal: 'owner' } });
      await client.connect();
      socket.send = () => { throw new Error('socket send failed'); };
      await expect(client.call('projects.list', {})).rejects.toThrow('socket send failed');
      expect(vi.getTimerCount()).toBe(0);
    } finally { client.close(); vi.useRealTimers(); }
  });

  test('a frame over the core limit is refused before it leaves, and the connection keeps working', async () => {
    const { client, socket } = connected();
    try {
      socket.open();
      socket.receive({ id: socket.frame(0).id, result: { core: CORE, principal: 'owner' } });
      await client.connect();
      const prompt = 'x'.repeat(RPC_MAX_FRAME_BYTES);
      let failure: unknown;
      await client.call('turns.start', { threadId: 'thread', prompt }).catch((error) => { failure = error; });
      expect(failure).toBeInstanceOf(RpcFailure);
      expect((failure as RpcFailure).code).toBe(RpcErrorCode.InvalidParams);
      expect((failure as Error).message).toBe('turns.start is 16 MB, over the 16 MB the core reads in one frame');
      expect(socket.sent).toHaveLength(1);
      expect(client.state).toBe('ready');

      const next = client.call('projects.list', {});
      socket.receive({ id: socket.frame(1).id, result: [] });
      expect(await next).toEqual([]);
    } finally { client.close(); }
  });

  test('a close for a frame too big says so to every call it drops', async () => {
    const { client, socket } = connected();
    socket.open();
    socket.receive({ id: socket.frame(0).id, result: { core: CORE, principal: 'owner' } });
    await client.connect();
    const pending = client.call('threads.list', {}).catch((error: Error) => error.message);
    socket.close(1009);
    expect(await pending).toBe('the core refused a frame over 16 MB and closed the connection');
  });

  test('resuming replaces a half-open socket without replaying a pending prompt', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = new WsClient({ url: 'https://core.test', token: 'session', socketFactory: () => {
      const socket = new FakeSocket(); sockets.push(socket); return socket;
    } });
    try {
      const connecting = client.connect();
      const first = take(sockets, 0);
      first.open();
      first.receive({ id: first.frame(0).id, result: { core: CORE, principal: 'session' } });
      await connecting;
      const pending = client.call('turns.start', { threadId: 'thread', prompt: 'once' }).catch(error => error);
      const resumed = client.resume();
      // The probe gets nothing back within its deadline.
      expect(first.sent.map(raw => JSON.parse(raw).method)).toEqual(['hello', 'turns.start', 'hello']);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(first.closed).toBe(true);
      const second = take(sockets, 1);
      second.open();
      second.receive({ id: second.frame(0).id, result: { core: CORE, principal: 'session' } });
      await resumed;
      expect(await pending).toBeInstanceOf(Error);
      expect(second.sent.map(raw => JSON.parse(raw).method)).toEqual(['hello']);
      client.close();
      await client.resume();
      expect(sockets).toHaveLength(2);
    } finally { client.close(); vi.useRealTimers(); }
  });

  test('resuming on a socket that answers keeps it, and the call it carries', async () => {
    const sockets: FakeSocket[] = [];
    const states: string[] = [];
    const client = new WsClient({ url: 'https://core.test', token: 'session', socketFactory: () => {
      const socket = new FakeSocket(); sockets.push(socket); return socket;
    } });
    client.onState((state) => states.push(state));
    const connecting = client.connect();
    const first = take(sockets, 0);
    first.open();
    first.receive({ id: first.frame(0).id, result: { core: CORE, principal: 'session' } });
    await connecting;
    const pending = client.call('threads.compact', { threadId: 'thread' });
    const resumed = client.resume();
    first.receive({ id: first.frame(2).id, result: { core: CORE, principal: 'session' } });
    await resumed;
    first.receive({ id: first.frame(1).id, result: { ok: true } });
    expect(await pending).toEqual({ ok: true });
    expect(first.closed).toBe(false);
    expect(sockets).toHaveLength(1);
    expect(states).toEqual(['connecting', 'ready']);
    client.close();
  });
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
