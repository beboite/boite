import {
  PROTOCOL_VERSION,
  RPC_PATH,
  RpcCloseCode,
  RpcErrorCode,
  type ClientName,
  type CoreInfo,
  type RpcError,
  type RpcEventName,
  type RpcEvents,
  type RpcMethodName,
  type RpcParams,
  type RpcResult,
  type ThreadId
} from '@boite/contracts';

export type ClientState = 'idle' | 'connecting' | 'ready' | 'closed';

export type EventHandler<E extends RpcEventName> = (payload: RpcEvents[E]) => void;

/** Every failure the core reports, and every failure of the transport itself. */
export class RpcFailure extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: RpcError) {
    super(error.message);
    this.name = 'RpcFailure';
    this.code = error.code;
    this.data = error.data;
  }
}

export interface Client {
  connect(): Promise<CoreInfo>;
  call<M extends RpcMethodName>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>;
  on<E extends RpcEventName>(event: E, handler: EventHandler<E>): () => void;
  readonly state: ClientState;
  close(): void;
}

/**
 * A client that also reports its own state changes, which a reconnect makes
 * necessary: nobody is awaiting `connect()` when the socket comes back.
 */
export interface ObservableClient extends Client {
  readonly core: CoreInfo | null;
  onState(handler: (state: ClientState) => void): () => void;
}

/** The slice of the browser WebSocket this client uses. A test supplies its own. */
export interface SocketMessage {
  data: unknown;
}

export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: SocketMessage) => void) | null;
  onclose: ((event?: { code?: number }) => void) | null;
  onerror: (() => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface WsClientOptions {
  /** HTTP origin of the core, for instance `http://127.0.0.1:8777`. */
  url: string;
  token: string;
  clientName?: ClientName;
  version?: string;
  socketFactory?: SocketFactory;
  reconnect?: boolean;
  /** Milliseconds before reconnect attempt `n`, zero based. */
  backoff?: (attempt: number) => number;
}

/** 1 s, 2 s, 4 s, 8 s, then 10 s forever. */
export function defaultBackoff(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 10_000);
}

export function rpcUrl(coreUrl: string): string {
  const url = new URL(coreUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${RPC_PATH}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

function transportFailure(message: string): RpcFailure {
  return new RpcFailure({ code: RpcErrorCode.Internal, message });
}

function browserSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

export class WsClient implements ObservableClient {
  #options: Required<Omit<WsClientOptions, 'clientName' | 'version'>> & {
    clientName: ClientName;
    version: string;
  };
  #socket: SocketLike | null = null;
  #state: ClientState = 'idle';
  #core: CoreInfo | null = null;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #handlers = new Map<string, Set<(payload: unknown) => void>>();
  #stateHandlers = new Set<(state: ClientState) => void>();
  #subscribed = new Set<ThreadId>();
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #manuallyClosed = false;

  constructor(options: WsClientOptions) {
    this.#options = {
      url: options.url,
      token: options.token,
      clientName: options.clientName ?? 'shell',
      version: options.version ?? '2.0.0-beta.1',
      socketFactory: options.socketFactory ?? browserSocket,
      reconnect: options.reconnect ?? true,
      backoff: options.backoff ?? defaultBackoff
    };
  }

  get state(): ClientState {
    return this.#state;
  }

  get core(): CoreInfo | null {
    return this.#core;
  }

  onState(handler: (state: ClientState) => void): () => void {
    this.#stateHandlers.add(handler);
    return () => this.#stateHandlers.delete(handler);
  }

  on<E extends RpcEventName>(event: E, handler: EventHandler<E>): () => void {
    let set = this.#handlers.get(event);
    if (!set) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    const erased = handler as (payload: unknown) => void;
    set.add(erased);
    return () => {
      set.delete(erased);
    };
  }

  connect(): Promise<CoreInfo> {
    if (this.#state === 'ready' && this.#core) return Promise.resolve(this.#core);
    this.#manuallyClosed = false;
    return this.#open();
  }

  call<M extends RpcMethodName>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    const socket = this.#socket;
    if (!socket || this.#state !== 'ready') {
      return Promise.reject(transportFailure('not connected'));
    }
    return this.#send(socket, method, params).then((value) => {
      if (method === 'threads.subscribe') {
        this.#subscribed.add((params as RpcParams<'threads.subscribe'>).threadId);
      } else if (method === 'threads.unsubscribe') {
        this.#subscribed.delete((params as RpcParams<'threads.unsubscribe'>).threadId);
      }
      return value;
    });
  }

  close(): void {
    this.#manuallyClosed = true;
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    this.#teardown('client closed');
    this.#setState('closed');
  }

  #setState(state: ClientState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const handler of this.#stateHandlers) handler(state);
  }

  #send<M extends RpcMethodName>(
    socket: SocketLike,
    method: M,
    params: RpcParams<M>
  ): Promise<RpcResult<M>> {
    const id = this.#nextId++;
    return new Promise<RpcResult<M>>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as RpcResult<M>),
        reject
      });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  #open(): Promise<CoreInfo> {
    this.#setState('connecting');
    const socket = this.#options.socketFactory(rpcUrl(this.#options.url));
    this.#socket = socket;

    return new Promise<CoreInfo>((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        reject(transportFailure(message));
      };

      socket.onmessage = (event) => this.#receive(event.data);
      socket.onerror = () => fail('socket error');
      socket.onclose = (event) => {
        const incompatible = event?.code === RpcCloseCode.ProtocolMismatch;
        if (incompatible) this.#manuallyClosed = true;
        this.#dropPending('connection closed');
        this.#socket = null;
        fail(incompatible ? `core protocol version must be ${PROTOCOL_VERSION}` : 'connection closed');
        if (this.#manuallyClosed || !this.#options.reconnect) {
          this.#setState('closed');
          return;
        }
        this.#setState('connecting');
        this.#scheduleRetry();
      };
      socket.onopen = () => {
        this.#send(socket, 'hello', {
          token: this.#options.token,
          protocolVersion: PROTOCOL_VERSION,
          client: { name: this.#options.clientName, version: this.#options.version }
        }).then(
          (result) => {
            if (result.core.protocolVersion !== PROTOCOL_VERSION) {
              this.#manuallyClosed = true;
              fail(`core protocol version must be ${PROTOCOL_VERSION}`);
              socket.close();
              return;
            }
            this.#attempt = 0;
            this.#core = result.core;
            this.#setState('ready');
            this.#resubscribe(socket);
            if (!settled) {
              settled = true;
              resolve(result.core);
            }
          },
          (error: unknown) => {
            if (!settled) {
              settled = true;
              reject(error instanceof Error ? error : transportFailure(String(error)));
            }
            // The hello parameters are fixed for this client. Retrying a
            // protocol rejection cannot make them compatible with the core.
            if (error instanceof RpcFailure && error.code === RpcErrorCode.InvalidParams) this.close();
            else socket.close();
          }
        );
      };
    });
  }

  #resubscribe(socket: SocketLike): void {
    for (const threadId of this.#subscribed) {
      void this.#send(socket, 'threads.subscribe', { threadId }).catch(() => undefined);
    }
  }

  #scheduleRetry(): void {
    if (this.#retryTimer !== null) return;
    const delay = this.#options.backoff(this.#attempt);
    this.#attempt += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (this.#manuallyClosed) return;
      void this.#open().catch(() => undefined);
    }, delay);
  }

  #dropPending(message: string): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) entry.reject(transportFailure(message));
  }

  #teardown(message: string): void {
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
    this.#dropPending(message);
  }

  #receive(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof frame !== 'object' || frame === null) return;
    const record = frame as Record<string, unknown>;

    if (typeof record['id'] === 'number') {
      const pending = this.#pending.get(record['id']);
      if (!pending) return;
      this.#pending.delete(record['id']);
      const error = record['error'];
      if (error && typeof error === 'object') {
        const shape = error as Record<string, unknown>;
        pending.reject(
          new RpcFailure({
            code: typeof shape['code'] === 'number' ? shape['code'] : RpcErrorCode.Internal,
            message: typeof shape['message'] === 'string' ? shape['message'] : 'unknown error',
            data: shape['data']
          })
        );
        return;
      }
      pending.resolve(record['result']);
      return;
    }

    const method = record['method'];
    if (typeof method !== 'string') return;
    const set = this.#handlers.get(method);
    if (!set) return;
    for (const handler of [...set]) handler(record['params']);
  }
}
