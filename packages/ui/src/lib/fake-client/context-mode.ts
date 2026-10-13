import { ContextRequestError, resolveContextFor, RpcErrorCode, type ThreadContextMode } from '@boite/contracts';
import { RpcFailure } from '../client';

/** The core's `checkContext`: the same resolution and the same refusal, by field. */
export function fakeContextMode(provider: { protocol: string; name: string }, request: unknown): ThreadContextMode | null {
  try {
    return resolveContextFor(provider, request);
  } catch (error) {
    if (error instanceof ContextRequestError) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: error.message, data: { field: `context.${error.field}` } });
    throw error;
  }
}
