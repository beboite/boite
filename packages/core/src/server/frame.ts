import { RpcErrorCode } from '@boite/contracts';
import type { Core } from '../core.ts';
import { RpcFailure, messageOf } from '../errors.ts';
import { ServerConnection } from './connection.ts';
import { hello } from './hello.ts';

export async function handleFrame(core: Core, connection: ServerConnection, raw: string): Promise<void> {
  let frame: { id?: unknown; method?: unknown; params?: unknown };
  try {
    frame = JSON.parse(raw) as { id?: unknown; method?: unknown; params?: unknown };
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('expected an RPC object');
  } catch {
    connection.sendResponse({
      jsonrpc: '2.0',
      id: 0,
      error: { code: RpcErrorCode.ParseError, message: 'the frame is not JSON' },
    });
    return;
  }

  const id = typeof frame.id === 'number' || typeof frame.id === 'string' ? frame.id : 0;
  const method = typeof frame.method === 'string' ? frame.method : '';

  if (!connection.authenticated) {
    hello(core, connection, id, method, frame.params);
    return;
  }

  if (method === 'hello') {
    connection.sendResponse({
      jsonrpc: '2.0',
      id,
      result: {
        core: core.info(),
        principal: connection.identity.principal,
        ...(connection.identity.threadId === null ? {} : { threadId: connection.identity.threadId }),
      },
    });
    return;
  }

  try {
    const result = await core.router.dispatch(method, frame.params, { connection });
    connection.sendResponse({ jsonrpc: '2.0', id, result });
  } catch (error) {
    if (error instanceof RpcFailure) {
      connection.sendResponse({ jsonrpc: '2.0', id, error: error.toError() });
      return;
    }
    // An unexpected throw is a bug here, not something the user can act on.
    // SQLite sentences, absolute paths and stack fragments used to reach the
    // screen verbatim. The cause stays in the log, the client gets a sentence.
    core.log('error', `${method} failed: ${messageOf(error)}`);
    connection.sendResponse({
      jsonrpc: '2.0',
      id,
      error: { code: RpcErrorCode.Internal, message: 'Something went wrong. Try again.' },
    });
  }
}
