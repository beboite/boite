import { createHash, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import { CLIENT_DEVICE_MAX, PROTOCOL_VERSION, RpcCloseCode, RpcErrorCode, type SentFrom } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf } from '../errors.ts';
import { NONCE_MAX, NONCE_MIN, nonceProblem, principalOf, type Identity } from '../sessions.ts';
import type { ServerConnection } from './connection.ts';

export async function hello(core: Core, connection: ServerConnection, id: number | string, method: string, rawParams: unknown): Promise<void> {
  // A device being admitted waits on another member when only that one knows its code: nothing else is read meanwhile.
  if (connection.greeting) {
    connection.close(RpcCloseCode.Unauthorized, 'hello in progress');
    return;
  }
  connection.greeting = true;
  try {
    await greet(core, connection, id, method, rawParams);
  } finally {
    connection.greeting = false;
  }
}

async function greet(core: Core, connection: ServerConnection, id: number | string, method: string, rawParams: unknown): Promise<void> {
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
    | { token?: unknown; grant?: unknown; ticket?: unknown; nonce?: unknown; device?: unknown; protocolVersion?: unknown; client?: { name?: unknown; version?: unknown; device?: unknown } }
    | undefined;
  const refuse = (message: string, reason: string): void => {
    connection.sendResponse({ jsonrpc: '2.0', id, error: { code: RpcErrorCode.Unauthorized, message } });
    connection.close(RpcCloseCode.Unauthorized, reason);
  };
  const token = typeof params?.token === 'string' ? params.token : null;
  const grant = typeof params?.grant === 'string' ? params.grant : null;
  const ticket = typeof params?.ticket === 'string' ? params.ticket : null;
  const device = typeof params?.device === 'object' && params.device !== null ? params.device as Record<string, unknown> : null;
  const client = {
    name: typeof params?.client?.name === 'string' ? params.client.name : 'unknown',
    version: typeof params?.client?.version === 'string' ? params.client.version : '',
  };

  let session: ReturnType<typeof core.sessions.exchange> | undefined;
  let admitted: string | undefined;
  let identity: Identity;
  // Absent, a grant is strictly one-shot. Present, a nonce must be usable, or
  // the client would believe a retry is safe when it is not.
  if (params?.nonce !== undefined) {
    const problem = grant === null && token !== null
      ? 'nonce goes with a grant; a hello with a token takes none'
      : nonceProblem(params.nonce);
    if (problem !== null) {
      connection.sendResponse({
        jsonrpc: '2.0', id, error: {
          code: RpcErrorCode.InvalidParams, message: problem, data: { field: 'nonce', min: NONCE_MIN, max: NONCE_MAX },
        }
      });
      connection.close(RpcCloseCode.Unauthorized, 'bad nonce');
      return;
    }
  }
  const wrongProtocol = (): boolean => {
    if (params?.protocolVersion === PROTOCOL_VERSION) return false;
    connection.sendResponse({
      jsonrpc: '2.0', id, error: {
        code: RpcErrorCode.InvalidParams, message: `protocolVersion must be ${PROTOCOL_VERSION}`,
      }
    });
    connection.close(RpcCloseCode.ProtocolMismatch, 'protocol version mismatch');
    return true;
  };
  if (device !== null && token === null && ticket === null) {
    // One key for every member of the group: admitted with a grant, then let in on its signature.
    if (wrongProtocol()) return;
    try {
      if (grant !== null) {
        const nonce = typeof params?.nonce === 'string' ? params.nonce : null;
        const done = await core.group.admitDevice(grant, device, client, nonce);
        admitted = done.deviceId;
        identity = { principal: principalOf(done.role), sessionId: done.sessionId, threadId: null };
      } else {
        const done = core.group.authenticateDevice(device, client);
        identity = { principal: principalOf(done.role), sessionId: done.sessionId, threadId: null };
      }
    } catch (error) {
      refuse(messageOf(error), grant === null ? 'bad device signature' : 'bad grant');
      return;
    }
  } else if (ticket !== null && token === null && grant === null) {
    // Like a grant, a ticket is spent once: the protocol is checked first.
    if (wrongProtocol()) return;
    try {
      session = core.group.admit(ticket, client);
    } catch (error) {
      refuse(messageOf(error), 'bad ticket');
      return;
    }
    identity = { principal: principalOf(session.role), sessionId: session.id, threadId: null };
  } else if (grant !== null && token === null && ticket === null) {
    // Check the protocol before consuming a one-shot grant.
    if (wrongProtocol()) return;
    try {
      const nonce = typeof params?.nonce === 'string' ? params.nonce : null;
      session = core.sessions.exchange(grant, client, Date.now(), nonce);
    } catch (error) {
      refuse(messageOf(error), 'bad grant');
      return;
    }
    identity = { principal: principalOf(session.role), sessionId: session.id, threadId: null };
  } else if (token !== null && grant === null && ticket === null) {
    const found = authenticateToken(core, token);
    if (found === null) { refuse('the token is wrong', 'bad token'); return; }
    identity = found;
  } else {
    refuse('hello takes a token, a grant, a group ticket or a device signature', 'bad hello');
    return;
  }
  if (wrongProtocol()) return;
  connection.identity = identity;
  connection.sentFrom = sentFromOf(identity, client.name, params?.client?.device, connection.remote);
  connection.clientName = client.name;
  connection.authenticated = true;
  // A page of this machine, served where its addresses do not say: the group learns that origin.
  if (identity.principal !== 'agent') servedOrigin(core, connection);
  connection.sendResponse({
    jsonrpc: '2.0',
    id,
    result: {
      core: core.info(),
      principal: identity.principal,
      ...(session === undefined ? {} : { session: { id: session.id, token: session.token } }),
      ...(admitted === undefined ? {} : { device: admitted }),
      // The agent learns which thread it is in from its own hello, so the CLI
      // needs nothing but the token to name it.
      ...(identity.threadId === null ? {} : { threadId: identity.threadId }),
    },
  });
}

/** The socket came from a page whose origin names the host it asked for: this machine is served there. */
function servedOrigin(core: Core, connection: ServerConnection): void {
  const { origin, host } = connection.dialed;
  if (origin === null || host === null) return;
  try {
    const url = new URL(origin);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== origin || url.host !== host.toLowerCase()) return;
    if (/^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname)) return;
    core.group.servedFrom(origin);
  } catch {
    // Not an origin: nothing learned.
  }
}

/**
 * Where this socket's prompts come from, for the agent's note. Only the
 * user's apps count: an agent's `boite` call or a test says nothing. The
 * shell on this machine's loopback is on this machine, whose name the core
 * knows better than the client does. Control, format and line or paragraph
 * separator characters go: the name lands inside a line of the agent's prompt.
 */
export function sentFromOf(identity: Identity, name: string, device: unknown, remote: boolean): SentFrom | null {
  if (identity.principal === 'agent' || (name !== 'shell' && name !== 'pwa')) return null;
  const said = typeof device === 'string' ? device.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').trim() : '';
  const named = said.length > 0 && said.length <= CLIENT_DEVICE_MAX ? said : null;
  return { client: name, device: named ?? (name === 'shell' && !remote ? hostname() : null) };
}

/** Equal without the time taken saying how much of the owner token matched. */
function sameSecret(given: string, secret: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(secret));
}

/** Owner tokens, paired sessions and per-thread agent tokens share the hello frame. */
export function authenticateToken(core: Core, token: string): Identity | null {
  if (sameSecret(token, core.token)) return { principal: 'owner', sessionId: null, threadId: null };
  if (token.length === 0) return null;
  const session = core.sessions.authenticate(token);
  // A key the group issued opens nothing once the address it was issued for is given up, whoever presents it.
  if (session !== null) return core.group.honours(session.id) ? { principal: principalOf(session.role), sessionId: session.id, threadId: null } : null;
  const threadId = core.agents.authenticate(token);
  return threadId === null ? null : { principal: 'agent', sessionId: null, threadId };
}
