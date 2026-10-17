import { RpcErrorCode } from '@boite/contracts';
import { RpcFailure } from './client';
import { wasClosed } from './rpc-error';
import { fill, strings } from './strings';

/** The core answered that it has no such method: it is older than this client. */
export function olderCore(error: unknown): boolean {
  return error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound;
}

/**
 * What a thrown value says: an `Error`'s message, anything else as text. A
 * core older than this client answers `unknown method group.addDevice`, which
 * tells the reader nothing they can act on: it reads as "update Boite on that
 * machine" instead, naming the machine when the caller knows it. A call
 * made while the machine was away says which machine is not connected.
 */
export function errorText(error: unknown, machine?: string): string {
  if (olderCore(error)) return machine ? fill(strings.errors.olderCore, { machine }) : strings.errors.olderCoreHere;
  // The transport's own "not connected" names the machine instead of reading as a bug.
  if (wasClosed(error)) return machine ? fill(strings.errors.notConnected, { machine }) : strings.errors.notConnectedHere;
  return error instanceof Error ? error.message : String(error);
}
