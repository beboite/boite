// Owns RPC failures and the markers used to retry interrupted calls.
import { RpcErrorCode, type RpcError, type RpcMethodName } from '@boite/contracts';

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

export function transportFailure(message: string): RpcFailure {
  return new RpcFailure({ code: RpcErrorCode.Internal, message });
}

/**
 * A call the connection lost before its answer came back: the core may or may
 * not have run it. A caller whose method the core deduplicates can ask again.
 */
export function droppedFailure(message: string): RpcFailure {
  return new RpcFailure({ code: RpcErrorCode.Internal, message, data: { transport: 'dropped' } });
}

export function wasDropped(error: unknown): boolean {
  return error instanceof RpcFailure && (error.data as { transport?: unknown } | undefined)?.transport === 'dropped';
}

/**
 * A call that got no answer in time. The core may well have run it: iOS
 * freezes a page in the background, and on its way back the call's timer
 * fires before the answer waiting on the socket is read.
 */
export function unansweredFailure(method: RpcMethodName): RpcFailure {
  return new RpcFailure({ code: RpcErrorCode.Internal, message: `${method} timed out; check the conversation before retrying`, data: { transport: 'unanswered' } });
}

/** Lost or unanswered: either way the core may have run the call, and a deduplicated one can be asked again. */
export function wasUnanswered(error: unknown): boolean {
  return wasDropped(error) || (error instanceof RpcFailure && (error.data as { transport?: unknown } | undefined)?.transport === 'unanswered');
}
