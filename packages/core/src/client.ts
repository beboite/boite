import { RPC_PATH } from '@boite/contracts';
import type {
  CoreInfo,
  RpcError,
  RpcEventName,
  RpcEvents,
  RpcMethodName,
  RpcMethods,
} from '@boite/contracts';

export interface ConnectOptions {
  client?: { name: string; version: string };
  timeoutMs?: number;
}

export interface CoreClient {
  readonly core: CoreInfo;
  call<M extends RpcMethodName>(method: M, params: RpcMethods[M]['params']): Promise<RpcMethods[M]['result']>;
  on<E extends RpcEventName>(event: E, handler: (payload: RpcEvents[E]) => void): () => void;
  onAny(handler: (event: RpcEventName, payload: unknown) => void): () => void;
  /** Resolves once an event matching the predicate arrives, or rejects on timeout. */
  next<E extends RpcEventName>(
    event: E,
    predicate?: (payload: RpcEvents[E]) => boolean,
    timeoutMs?: number,
  ): Promise<RpcEvents[E]>;
  close(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class RpcCallError extends Error {
  constructor(readonly rpc: RpcError) {
    super(rpc.message);
    this.name = 'RpcCallError';
  }
}

function socketUrl(url: string): string {
  const base = url.replace(/^http/, 'ws').replace(/\/+$/, '');
  return base.endsWith(RPC_PATH) ? base : base + RPC_PATH;
}

export async function connect(url: string, token: string, options: ConnectOptions = {}): Promise<CoreClient> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const socket = new WebSocket(socketUrl(url));
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let nextId = 1;
  let closed = false;

  const send = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId;
    nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  };

  socket.addEventListener('message', (event: MessageEvent) => {
    const raw = typeof event.data === 'string' ? event.data : '';
    let frame: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: RpcError };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return;
    }
    if (typeof frame.id === 'number') {
      const waiter = pending.get(frame.id);
      if (waiter === undefined) return;
      pending.delete(frame.id);
      if (frame.error !== undefined) waiter.reject(new RpcCallError(frame.error));
      else waiter.resolve(frame.result);
      return;
    }
    if (typeof frame.method !== 'string') return;
    for (const handler of listeners.get(frame.method) ?? []) handler(frame.params);
    for (const handler of listeners.get('*') ?? []) handler({ event: frame.method, payload: frame.params });
  });

  socket.addEventListener('close', () => {
    closed = true;
    for (const waiter of pending.values()) waiter.reject(new Error('the socket closed'));
    pending.clear();
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the socket did not open')), timeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('the socket failed to open'));
    });
  });

  const hello = (await send('hello', {
    token,
    client: options.client ?? { name: 'test', version: '2.0.0-beta.1' },
  })) as { core: CoreInfo };

  const on = (event: string, handler: (payload: unknown) => void): (() => void) => {
    let set = listeners.get(event);
    if (set === undefined) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  };

  return {
    core: hello.core,
    async call<M extends RpcMethodName>(method: M, params: RpcMethods[M]['params']): Promise<RpcMethods[M]['result']> {
      if (closed) throw new Error('the client is closed');
      return (await send(method, params)) as RpcMethods[M]['result'];
    },
    on<E extends RpcEventName>(event: E, handler: (payload: RpcEvents[E]) => void): () => void {
      return on(event, (payload) => handler(payload as RpcEvents[E]));
    },
    onAny(handler: (event: RpcEventName, payload: unknown) => void): () => void {
      return on('*', (wrapped) => {
        const entry = wrapped as { event: RpcEventName; payload: unknown };
        handler(entry.event, entry.payload);
      });
    },
    next<E extends RpcEventName>(
      event: E,
      predicate?: (payload: RpcEvents[E]) => boolean,
      waitMs = 5000,
    ): Promise<RpcEvents[E]> {
      return new Promise<RpcEvents[E]>((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error(`timed out waiting for ${event}`));
        }, waitMs);
        const off = on(event, (payload) => {
          const typed = payload as RpcEvents[E];
          if (predicate !== undefined && !predicate(typed)) return;
          clearTimeout(timer);
          off();
          resolve(typed);
        });
      });
    },
    close(): void {
      closed = true;
      socket.close();
    },
  };
}
