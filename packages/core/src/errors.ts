import { RpcErrorCode } from '@boite/contracts';
import type { RpcError } from '@boite/contracts';

export class RpcFailure extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcFailure';
    this.code = code;
    this.data = data;
  }

  toError(): RpcError {
    if (this.data === undefined) return { code: this.code, message: this.message };
    return { code: this.code, message: this.message, data: this.data };
  }
}

export function invalidParams(message: string, data?: unknown): RpcFailure {
  return new RpcFailure(RpcErrorCode.InvalidParams, message, data);
}

export function notFound(message: string, data?: unknown): RpcFailure {
  return new RpcFailure(RpcErrorCode.NotFound, message, data);
}

export function refused(message: string, data?: unknown): RpcFailure {
  return new RpcFailure(RpcErrorCode.Refused, message, data);
}

/**
 * A folder the core was told to work in is no longer on the disk. One sentence
 * for every method that meets it, so a deleted repository never reads as a
 * missing git or an empty folder.
 */
export function folderGone(path: string, data: Record<string, unknown> = {}): RpcFailure {
  return refused(`the folder ${path} does not exist any more: it was deleted, moved or renamed`, { ...data, path, expected: 'an existing folder' });
}

export function unavailable(message: string, data?: unknown): RpcFailure {
  return new RpcFailure(RpcErrorCode.Unavailable, message, data);
}

export function unauthorized(message: string, data?: unknown): RpcFailure {
  return new RpcFailure(RpcErrorCode.Unauthorized, message, data);
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
