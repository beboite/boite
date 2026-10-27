// Owns the public client contracts and the stable exports used by UI callers.
import type { DeviceKey } from './device-key';
import type { ClientName, CoreInfo, DeviceHello, Principal, RpcEventName, RpcEvents, RpcMethodName, RpcParams, RpcResult } from '@boite/contracts';
import type { RpcFailure } from './rpc-error';

export { RpcFailure, droppedFailure, wasDropped, unansweredFailure, wasUnanswered } from './rpc-error';
export { defaultBackoff, openDeadline, rpcUrl } from './ws-client-utils';
export { WsClient } from './ws-client';

export type ClientState = 'idle' | 'connecting' | 'ready' | 'closed';

export type EventHandler<E extends RpcEventName> = (payload: RpcEvents[E]) => void;

/**
 * `onProgress` hears how many bytes of the answer arrived and how many it
 * weighs, the core's own count, as each slice lands. A short answer, or one
 * from a core that sends answers whole, reports nothing before it resolves.
 */
export interface CallOptions {
  onProgress?: (received: number, total: number) => void;
}

export interface Client {
  connect(): Promise<CoreInfo>;
  call<M extends RpcMethodName>(method: M, params: RpcParams<M>, options?: CallOptions): Promise<RpcResult<M>>;
  on<E extends RpcEventName>(event: E, handler: EventHandler<E>): () => void;
  readonly state: ClientState;
  /** Who the core took this client for on the last hello; null before one. */
  readonly principal: Principal | null;
  /**
   * How far the core's clock runs ahead of this device's, in milliseconds,
   * measured on the last hello; zero or absent when unknown. An elapsed time
   * counted from a core timestamp adds it to `Date.now()`.
   */
  readonly clockOffset?: number;
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
  /**
   * A group ticket (`group.ticket`), used once like a grant: another member of
   * the core's group vouched for this client, and the session that comes back
   * is stored the same way.
   */
  ticket?: string;
  /**
   * When `url` is another member's relay route (`groupRelayUrl`), this
   * client's key for that member, read at every connection: the member checks
   * it and passes the rest of the hello on. Null when no key is held for it:
   * nothing is sent then, since the hello carries this client's key for the
   * machine at the end and would hand it to a member it is no longer paired with.
   */
  relay?: () => string | DeviceHello | null;
  /**
   * This device's key, for a machine of its group: every hello carries a
   * signature made for `coreId`. With `grant`, the key is admitted to the
   * group instead, and `onDevice` hears the device id and the machine's id.
   */
  signer?: { key: () => Promise<DeviceKey>; coreId: string | null };
  /** A grant just admitted this device's key: its id, and the id of the machine that let it in. */
  onDevice?: (device: string, coreId: string) => unknown;
  /** Returning false refuses the key: the client closes instead of using it. */
  onSession?: (session: Session) => unknown;
  /**
   * The token is the session key of a pairing, whatever role it speaks as. A
   * key paired with the owner role says hello as the owner, so the principal
   * alone cannot tell a revoked key from a core token that changed.
   */
  paired?: boolean;
  /** The session this client held stopped opening the core: it was revoked. The client is closed for good. */
  onRevoked?: () => void;
  /** Every authentication refusal during hello, including automatic retries and resume attempts. */
  onUnauthorized?: (error: RpcFailure) => void;
  /**
   * The machine refused a hello saying it is in no group (`UngroupedData`),
   * signed with its key over that hello: its own word, as a `group.get`
   * answering null. The client keeps trying, as a group that lets it in again
   * tells it of this device.
   */
  onUngrouped?: () => void;
  clientName?: ClientName;
  version?: string;
  /** What this client runs on, read at every hello (`hello` `client.device`); null says nothing. */
  device?: () => string | null;
  socketFactory?: SocketFactory;
  reconnect?: boolean;
  /** Milliseconds before reconnect attempt `n`, zero based. */
  backoff?: (attempt: number) => number;
  /** Milliseconds attempt `n`, zero based, has to open its socket and have its hello answered. `openDeadline` by default. */
  openDeadline?: (attempt: number) => number;
}

/** True once `client` is ready again, false when it closes or `waitMs` passes first. */
export function readyAgain(client: Client, waitMs = 15_000): Promise<boolean> {
  if (client.state === 'ready') return Promise.resolve(true);
  if (!('onState' in client) || client.state === 'closed') return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (ready: boolean) => { clearTimeout(timer); stop(); resolve(ready); };
    const timer = setTimeout(() => done(false), waitMs);
    const stop = (client as ObservableClient).onState((state) => {
      if (state === 'ready' || state === 'closed') done(state === 'ready');
    });
  });
}
