import { RpcCloseCode } from '@boite/contracts';
import type { Core } from '../core.ts';
import type { RpcFailure } from '../errors.ts';
import type { ServerConnection } from './connection.ts';

/** An RPC slower than this is worth a debug line; slower than the second, a warning. */
export const SLOW_RPC_DEBUG_MS = 1_000;
export const SLOW_RPC_WARN_MS = 10_000;

/**
 * Methods that hold their answer on purpose until something happens: a wait
 * on another agent, a question to the user, a browser command. Their duration
 * is the wait, not a sign of a stalled core, so they never reach `warn`.
 */
const HELD_METHODS = /^(delegation\.(wait|send)|collaboration\.(wait|send)|questions\.ask|agents\.decision\.request|browser\.|devices\.|terminals\.|panel\.|accounts\.login|providers\.(install|update|dryRun)|plugins\.(install|uninstall)|speech\.(install|transcribe|stream)|imports\.run|brain\.sync|core\.update)/;

/** Who is behind a socket, in words a timeline reader understands. */
export function describeConnection(connection: ServerConnection): { principal: string; client: string; remote: boolean } {
  return {
    principal: connection.authenticated ? connection.identity.principal : 'unauthenticated',
    client: connection.sentFrom?.client ?? connection.clientName,
    remote: connection.remote,
  };
}

/**
 * Normal closes from a person's app are lifecycle; anything abnormal is a
 * warning. A refused hello already has its own warning, so its close is detail.
 */
export function closeLevel(code: number, reason: string, authenticated: boolean, principal: string): 'debug' | 'info' | 'warn' {
  const abnormal = code === 1006 || code === 1009 || code === 1011 || code === 1013 || (code === RpcCloseCode.Unauthorized && reason === 'hello timed out');
  if (abnormal) return 'warn';
  // Every `boite` call from an agent opens and closes a socket: that is detail.
  return principal === 'agent' || !authenticated ? 'debug' : 'info';
}

export function logHelloAccepted(core: Core, connection: ServerConnection, clientVersion: string): void {
  const who = describeConnection(connection);
  const level = who.principal === 'agent' ? 'debug' : 'info';
  core.logs.record(level, `Connection ${connection.id} said hello as ${who.principal} from ${who.client}${who.remote ? ' over the network' : ' on this machine'}`, {
    source: 'connections', event: 'connection.hello', threadId: connection.identity.threadId ?? undefined,
    data: { connectionId: connection.id, ...who, clientVersion: clientVersion || null, device: connection.sentFrom?.device ?? null, sessionId: connection.identity.sessionId },
  });
}

export function logHelloRefused(core: Core, connection: ServerConnection, reason: string, clientName: string): void {
  core.logs.warn(`Connection ${connection.id} from ${clientName}${connection.remote ? ' over the network' : ' on this machine'} was refused at hello: ${reason}`, {
    source: 'connections', event: 'connection.hello-refused', data: { connectionId: connection.id, reason, client: clientName, remote: connection.remote },
  });
}

export function logConnectionClosed(core: Core, connection: ServerConnection, code: number, reason: string | undefined): void {
  const who = describeConnection(connection);
  const lifetime = Date.now() - connection.openedAt;
  const by = connection.closedBy;
  const level = closeLevel(by?.code ?? code, by?.reason ?? reason ?? '', connection.authenticated, who.principal);
  const cause = by !== null ? `the core closed it with ${by.code}${by.reason ? ` (${by.reason})` : ''}` : `the client closed it with ${code}${reason ? ` (${reason})` : ''}`;
  core.logs.record(level, `Connection ${connection.id} of ${who.principal} from ${who.client} closed after ${formatSeconds(lifetime)}: ${cause}`, {
    source: 'connections', event: 'connection.closed', durationMs: lifetime, threadId: connection.identity.threadId ?? undefined,
    data: { connectionId: connection.id, ...who, code: by?.code ?? code, reason: (by?.reason ?? reason) || null, closedBy: by !== null ? 'core' : 'client', subscriptions: connection.subscriptions.size },
  });
}

/** Level for an RPC that answered: null when it is quick enough to say nothing. */
export function slowRpcLevel(method: string, ms: number): 'debug' | 'warn' | null {
  if (ms >= SLOW_RPC_WARN_MS && !HELD_METHODS.test(method)) return 'warn';
  if (ms >= SLOW_RPC_DEBUG_MS) return 'debug';
  return null;
}

export function logRpcTiming(core: Core, connection: ServerConnection, method: string, requestId: string, ms: number, failure: RpcFailure | null): void {
  const threadId = connection.identity.threadId ?? undefined;
  if (failure !== null) {
    core.logs.debug(`${method} refused with code ${failure.code}: ${failure.message}`, {
      source: 'rpc', event: 'rpc.refused', requestId, threadId, durationMs: ms,
      data: { method, code: failure.code, principal: connection.identity.principal },
    });
    return;
  }
  const level = slowRpcLevel(method, ms);
  if (level === null) return;
  core.logs.record(level, `${method} took ${formatSeconds(ms)} to answer`, {
    source: 'rpc', event: 'rpc.slow', requestId, threadId, durationMs: ms,
    data: { method, principal: connection.identity.principal },
  });
}

function formatSeconds(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
