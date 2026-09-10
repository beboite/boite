import { RpcErrorCode } from '@boite/contracts';
import type { RpcEventName, RpcEvents, RpcMethodName, RpcMethods, ThreadId } from '@boite/contracts';
import { RpcFailure } from './errors.ts';
import type { Identity } from './sessions.ts';

/** What a handler is allowed to know about the socket it was called on. */
export interface Connection {
  readonly id: string;
  readonly subscriptions: Set<ThreadId>;
  /** Who said hello: the owner, or a paired session by id. */
  readonly identity: Identity;
  sendEvent<E extends RpcEventName>(name: E, payload: RpcEvents[E]): void;
  close(code: number, reason?: string): void;
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

  register<M extends RpcMethodName>(method: M, handler: Handler<M>): void {
    this.handlers.set(method, handler);
  }

  has(method: string): boolean {
    return this.handlers.has(method as RpcMethodName);
  }

  async dispatch(method: string, params: unknown, ctx: RpcContext): Promise<unknown> {
    const handler = this.handlers.get(method as RpcMethodName);
    if (handler === undefined) {
      throw new RpcFailure(RpcErrorCode.MethodNotFound, `unknown method ${method}`, { method });
    }
    return await handler(params as never, ctx);
  }
}
