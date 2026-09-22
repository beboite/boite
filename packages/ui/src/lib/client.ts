import {
  PROTOCOL_VERSION,
  RPC_PATH,
  RpcCloseCode,
  RpcErrorCode,
  type ClientName,
  type CoreInfo,
  type Principal,
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
  /** Who the core took this client for on the last hello; null before one. */
  readonly principal: Principal | null;
  close(): void;
}

/** What a grant hello hands back: the token this client says hello with from then on. */
export interface Session {
  id: string;
  token: string;
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
  /**
   * A one-time pairing grant, used on the first hello instead of the token.
   * The session it becomes replaces the token for every hello after, and
   * `onSession` is where the caller stores it.
   */
  grant?: string;
  onSession?: (session: Session) => void;
  /**
   * The token is the session key of a pairing, whatever role it speaks as. A
   * key paired with the owner role says hello as the owner, so the principal
   * alone cannot tell a revoked key from a core token that changed.
   */
  paired?: boolean;
  /** The session this client held stopped opening the core: it was revoked. The client is closed for good. */
  onRevoked?: () => void;
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
  #options: Required<Omit<WsClientOptions, 'clientName' | 'version' | 'grant' | 'paired' | 'onSession' | 'onRevoked'>> & {
    clientName: ClientName;
    version: string;
  };
  /** Spent on the first hello that answers; a refused grant is not retried. */
  #grant: string | null;
  /** The token is a pairing's session key, so a hello it no longer opens is a revoke. */
  #paired: boolean;
  #onSession: ((session: Session) => void) | null;
  #onRevoked: (() => void) | null;
  #principal: Principal | null = null;
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
  #opening: Promise<CoreInfo> | null = null;
  #cancelOpen: (() => void) | null = null;

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
    this.#grant = options.grant ?? null;
    this.#paired = options.paired ?? options.grant !== undefined;
    this.#onSession = options.onSession ?? null;
    this.#onRevoked = options.onRevoked ?? null;
  }

  get state(): ClientState {
    return this.#state;
  }

  get principal(): Principal | null {
    return this.#principal;
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
    if (this.#opening) return this.#opening;
    this.#manuallyClosed = false;
    return this.#startOpen();
  }

  /** A mobile browser can retain a dead socket after sleep without firing close. */
  async resume(): Promise<void> {
    if (this.#manuallyClosed || this.#state === 'idle') return;
    // A one-time grant must finish its exchange before any connection replaces it.
    if (this.#grant !== null && this.#opening) { await this.#opening; return; }
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#teardown('connection resumed; check the conversation before resending');
    await this.#startOpen();
  }

  #startOpen(): Promise<CoreInfo> {
    const opening = this.#open();
    this.#opening = opening;
    void opening.finally(() => {
      if (this.#opening === opening) this.#opening = null;
    }).catch(() => undefined);
    return opening;
  }

  call<M extends RpcMethodName>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    // Forget locally even when an offline host cannot acknowledge the unsubscribe.
    if (method === 'threads.unsubscribe') this.#subscribed.delete((params as RpcParams<'threads.unsubscribe'>).threadId);
    const socket = this.#socket;
    if (!socket || this.#state !== 'ready') {
      return Promise.reject(transportFailure('not connected'));
    }
    return this.#send(socket, method, params).then((value) => {
      if (method === 'threads.subscribe') {
        this.#subscribed.add((params as RpcParams<'threads.subscribe'>).threadId);
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
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(transportFailure(`${method} timed out; check the conversation before retrying`));
      }, 120_000);
      const pending: Pending = {
        resolve: (value) => { clearTimeout(timer); resolve(value as RpcResult<M>); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      };
      this.#pending.set(id, pending);
      try { socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }
      catch (error) {
        this.#pending.delete(id);
        pending.reject(error instanceof Error ? error : transportFailure(String(error)));
      }
    });
  }

  #open(): Promise<CoreInfo> {
    this.#setState('connecting');
    const socket = this.#options.socketFactory(rpcUrl(this.#options.url));
    this.#socket = socket;

    return new Promise<CoreInfo>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        fail('connection did not answer within 10 seconds');
        socket.close();
      }, 10_000);
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(transportFailure(message));
      };
      this.#cancelOpen = () => fail('connection replaced');

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
        const grant = this.#grant;
        this.#send(socket, 'hello', {
          ...(grant === null ? { token: this.#options.token } : { grant }),
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
            if (result.session) {
              // The grant is spent: from here on this client is its session.
              this.#grant = null;
              this.#paired = true;
              this.#options.token = result.session.token;
              this.#onSession?.(result.session);
            }
            this.#principal = result.principal;
            this.#attempt = 0;
            this.#core = result.core;
            this.#setState('ready');
            this.#resubscribe(socket);
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              resolve(result.core);
            }
          },
          (error: unknown) => {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              reject(error instanceof Error ? error : transportFailure(String(error)));
            }
            // The hello parameters are fixed for this client. Retrying a
            // protocol rejection cannot make them compatible with the core,
            // and a grant the core refused once is spent or expired: the
            // retry would only say so again.
            // A session whose key stopped opening the core was revoked from
            // the desktop: retrying every ten seconds would never pair it again.
            const revoked =
              (this.#principal === 'session' || (this.#paired && grant === null)) &&
              error instanceof RpcFailure &&
              error.code === RpcErrorCode.Unauthorized;
            const permanent =
              revoked ||
              (error instanceof RpcFailure &&
                (error.code === RpcErrorCode.InvalidParams || (grant !== null && error.code === RpcErrorCode.Unauthorized)));
            if (permanent) this.close();
            else socket.close();
            if (revoked) this.#onRevoked?.();
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
      void this.#startOpen().catch(() => undefined);
    }, delay);
  }

  #dropPending(message: string): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) entry.reject(transportFailure(message));
  }

  #teardown(message: string): void {
    this.#cancelOpen?.();
    this.#cancelOpen = null;
    this.#opening = null;
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
