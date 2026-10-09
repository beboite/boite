import { RpcErrorCode } from '@boite/contracts';
import type { RpcEventName, RpcEvents, RpcMethodName, RpcMethods, SentFrom, ThreadId, TransportOptions } from '@boite/contracts';
import { assertAllowed } from './access.ts';
import { RpcFailure } from './errors.ts';
import type { Identity } from './sessions.ts';

/** What a handler is allowed to know about the socket it was called on. */
export interface Connection {
  readonly id: string;
  readonly subscriptions: Set<ThreadId>;
  /** Who said hello: the owner, or a paired session by id. */
  readonly identity: Identity;
  /** What the client's last opened page left on the core: live tool parts follow the same rule. */
  transport?: TransportOptions;
  /** The app behind the socket, set by hello; null for an agent, the CLI and tests. */
  readonly sentFrom?: SentFrom | null;
  /** The client connected from another machine, or reached the core by a name other than this machine's loopback. */
  readonly remote?: boolean;
  sendEvent<E extends RpcEventName>(name: E, payload: RpcEvents[E]): void;
  close(code: number, reason?: string): void;
  /** Release held requests when this socket leaves, without stopping their work. */
  onClose?(callback: () => void): () => void;
}

export interface RpcContext {
  connection: Connection;
}

export type Handler<M extends RpcMethodName> = (
  params: RpcMethods[M]['params'],
  ctx: RpcContext,
) => RpcMethods[M]['result'] | Promise<RpcMethods[M]['result']>;

type ErasedHandler = (params: never, ctx: RpcContext) => unknown;

export class Router {
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
    return await this.trackRequest(() => handler(params as never, ctx));
  }
}
