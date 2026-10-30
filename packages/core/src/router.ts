import { checkRpcParams, RpcErrorCode } from '@boite/contracts';
import type { RpcEventName, RpcEvents, RpcMethodName, RpcMethods, SentFrom, ThreadId, TransportOptions } from '@boite/contracts';
import { assertAllowed } from './access.ts';
import { invalidParams, RpcFailure } from './errors.ts';
import type { Identity } from './sessions.ts';

/** What a handler is allowed to know about the socket it was called on. */
export interface Connection {
  readonly id: string;
  readonly subscriptions: Set<ThreadId>;
  /** Who said hello: the owner, or a paired session by id. */
  readonly identity: Identity;
  /** What the client's last opened page left on the core: live tool parts, files and pictures follow the same rule. */
  transport?: TransportOptions;
  /** The app behind the socket, set by hello; null for an agent, the CLI and tests. */
  readonly sentFrom?: SentFrom | null;
  /** Reached by a name other than this machine's loopback: a phone, a laptop, a tunnel. Unset counts as remote. */
  readonly remote?: boolean;
  /**
   * The bytes cannot be read on the way: this machine's own loopback, a
   * Tailscale peer, or HTTPS terminated on this machine. Unset counts as plain;
   * a secret is answered or deleted only where it is true.
   */
  readonly encrypted?: boolean;
  /** The client name hello gave (`shell`, `pwa`, `plugin`, `cli`); unset for tests that build a connection by hand. */
  readonly clientName?: string;
  sendEvent<E extends RpcEventName>(name: E, payload: RpcEvents[E]): void;
  close(code: number, reason?: string): void;
  /** Release held requests when this socket leaves, without stopping their work. */
  onClose?(callback: () => void): () => void;
}

export interface RpcContext {
  connection: Connection;
  /**
   * Aborts when the caller's connection closes before the answer. The request
   * no longer counts against the RPC admission limits by then, so a wait that
   * serves only this caller stops; work that must finish may go on.
   */
  signal?: AbortSignal;
}

export type Handler<M extends RpcMethodName> = (
  params: RpcMethods[M]['params'],
  ctx: RpcContext,
) => RpcMethods[M]['result'] | Promise<RpcMethods[M]['result']>;

type ErasedHandler = (params: never, ctx: RpcContext) => unknown;

export class Router {
  /** Host execution policy, in addition to the static caller-role map. Local sessions have no shared binding. */
  guard?: (method: RpcMethodName, params: unknown, ctx: RpcContext) => void;
  /** The admin policy's refusals (`policy-gate.ts`), for every caller the owner included. */
  policy?: (method: RpcMethodName, params: unknown) => void;
  private readonly handlers = new Map<RpcMethodName, ErasedHandler>();
  private accepting = true;
  private active = 0;

  get activeRequests(): number { return this.active; }
  stopAccepting(): void { this.accepting = false; }

  register<M extends RpcMethodName>(method: M, handler: Handler<M>): void {
    this.handlers.set(method, handler);
  }

  has(method: string): boolean {
    return this.handlers.has(method as RpcMethodName);
  }

  /** Every method registered, which is what the access test walks. */
  methods(): RpcMethodName[] {
    return [...this.handlers.keys()];
  }

  /** RPCs and signed peer HTTP requests share idle update admission. */
  async trackRequest<T>(work: () => T | Promise<T>): Promise<T> {
    if (!this.accepting) throw new RpcFailure(RpcErrorCode.InvalidRequest, 'the core is stopping; reconnect before sending another request');
    this.active += 1;
    try { return await work(); }
    finally { this.active -= 1; }
  }

  async dispatch(method: string, params: unknown, ctx: RpcContext): Promise<unknown> {
    if (!this.accepting) throw new RpcFailure(RpcErrorCode.InvalidRequest, 'the core is stopping; reconnect before sending another request');
    const handler = this.handlers.get(method as RpcMethodName);
    if (handler === undefined) {
      throw new RpcFailure(RpcErrorCode.MethodNotFound, `unknown method ${method}`, { method });
    }
    // Every method goes through the same gate, so a new one is the owner's
    // until `DEVICE_METHODS` or `AGENT_METHODS` says otherwise. The params go
    // with it: an agent is held to the thread its token was minted for.
    assertAllowed(method as RpcMethodName, ctx.connection, params);
    // A method with rules in contracts gets only params they accepted, as they normalized them.
    const checked = checkRpcParams(method, params);
    if (!checked.ok) throw invalidParams(checked.message, { field: checked.field });
    this.policy?.(method as RpcMethodName, checked.params);
    this.guard?.(method as RpcMethodName, checked.params, ctx);
    return await this.trackRequest(() => handler(checked.params as never, ctx));
  }
}
