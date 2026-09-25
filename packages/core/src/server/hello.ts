import { PROTOCOL_VERSION, RpcCloseCode, RpcErrorCode } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf } from '../errors.ts';
import { principalOf, type Identity } from '../sessions.ts';
import type { ServerConnection } from './connection.ts';

export function hello(core: Core, connection: ServerConnection, id: number | string, method: string, rawParams: unknown): void {
  if (method !== 'hello') {
    connection.sendResponse({
      jsonrpc: '2.0',
      id,
      error: { code: RpcErrorCode.Unauthorized, message: 'the first frame must be hello' },
    });
    connection.close(RpcCloseCode.Unauthorized, 'hello expected');
    return;
  }
  const params = rawParams as
    | { token?: unknown; grant?: unknown; nonce?: unknown; protocolVersion?: unknown; client?: { name?: unknown; version?: unknown } }
    | undefined;
  const refuse = (message: string, reason: string): void => {
    connection.sendResponse({ jsonrpc: '2.0', id, error: { code: RpcErrorCode.Unauthorized, message } });
    connection.close(RpcCloseCode.Unauthorized, reason);
  };
  const token = typeof params?.token === 'string' ? params.token : null;
  const grant = typeof params?.grant === 'string' ? params.grant : null;
  const nonce = typeof params?.nonce === 'string' ? params.nonce : null;
  const client = {
    name: typeof params?.client?.name === 'string' ? params.client.name : 'unknown',
    version: typeof params?.client?.version === 'string' ? params.client.version : '',
  };

  let session: ReturnType<typeof core.sessions.exchange> | undefined;
  let identity: Identity;
  if (grant !== null && token === null) {
    // Check the protocol before consuming a one-shot grant.
    if (params?.protocolVersion !== PROTOCOL_VERSION) {
      connection.sendResponse({
        jsonrpc: '2.0', id, error: {
          code: RpcErrorCode.InvalidParams, message: `protocolVersion must be ${PROTOCOL_VERSION}`,
        }
      });
      connection.close(RpcCloseCode.ProtocolMismatch, 'protocol version mismatch');
      return;
    }
    try {
      session = core.sessions.exchange(grant, client, Date.now(), nonce);
    } catch (error) {
      refuse(messageOf(error), 'bad grant');
      return;
    }
    identity = { principal: principalOf(session.role), sessionId: session.id, threadId: null };
  } else if (token !== null && grant === null) {
    const found = authenticateToken(core, token);
    if (found === null) { refuse('the token is wrong', 'bad token'); return; }
    identity = found;
  } else {
    refuse('hello takes a token or a grant, one of the two', 'bad hello');
    return;
  }
  if (params?.protocolVersion !== PROTOCOL_VERSION) {
    connection.sendResponse({
      jsonrpc: '2.0', id, error: {
        code: RpcErrorCode.InvalidParams, message: `protocolVersion must be ${PROTOCOL_VERSION}`,
      }
    });
    connection.close(RpcCloseCode.ProtocolMismatch, 'protocol version mismatch');
    return;
  }
  connection.identity = identity;
  connection.authenticated = true;
  connection.sendResponse({
    jsonrpc: '2.0',
    id,
    result: {
      core: core.info(),
      principal: identity.principal,
      ...(session === undefined ? {} : { session: { id: session.id, token: session.token } }),
      // The agent learns which thread it is in from its own hello, so the CLI
      // needs nothing but the token to name it.
      ...(identity.threadId === null ? {} : { threadId: identity.threadId }),
    },
  });
}

/** Owner tokens, paired sessions and per-thread agent tokens share the hello frame. */
function authenticateToken(core: Core, token: string): Identity | null {
  if (token === core.token) return { principal: 'owner', sessionId: null, threadId: null };
  if (token.length === 0) return null;
  const session = core.sessions.authenticate(token);
  if (session !== null) return { principal: principalOf(session.role), sessionId: session.id, threadId: null };
  const threadId = core.agents.authenticate(token);
  return threadId === null ? null : { principal: 'agent', sessionId: null, threadId };
}
