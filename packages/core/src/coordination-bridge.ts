import { randomUUID } from 'node:crypto';
import type { CoordinationBridgeResponse, RpcEvents } from '@boite/contracts';
import type { Connection } from './router.ts';
import { invalidParams, refused, unavailable } from './errors.ts';

const MAX_BODY = 262_144;
type Pending = {
  coreId: string;
  connectionId: string;
  finish: (response: CoordinationBridgeResponse | Error) => void;
};

/** An owner app relays signed envelopes; it never supplies a peer's identity or permissions. */
export class CoordinationBridge {
  private readonly routes = new Map<string, Map<string, Connection>>();
  private readonly pending = new Map<string, Pending>();

  register(coreId: string, enabled: boolean, connection: Connection): { ok: true } {
    if (typeof enabled !== 'boolean') throw invalidParams('enabled: expected a boolean');
    const routes = this.routes.get(coreId) ?? new Map<string, Connection>();
    if (enabled) routes.set(connection.id, connection);
    else {
      routes.delete(connection.id);
      for (const request of this.pending.values()) if (request.coreId === coreId && request.connectionId === connection.id) request.finish(unavailable('owner app disconnected from this machine'));
    }
    if (routes.size) this.routes.set(coreId, routes);
    else this.routes.delete(coreId);
    return { ok: true };
  }

  available(coreId: string): boolean { return (this.routes.get(coreId)?.size ?? 0) > 0; }

  request(coreId: string, envelope: Omit<RpcEvents['collaboration.bridge.request'], 'requestId'>): Promise<CoordinationBridgeResponse> {
    const connections = [...(this.routes.get(coreId)?.values() ?? [])];
    const connection = connections.at(-1);
    if (!connection) throw unavailable('open the owner app connected to both machines to read this client');
    if (this.pending.size >= 32) throw unavailable('too many agent requests are waiting for the owner app');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(unavailable('owner app did not relay the request within 5 seconds')), 5000);
      const finish = (response: CoordinationBridgeResponse | Error) => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer);
        if (response instanceof Error) reject(response); else resolve(response);
      };
      this.pending.set(requestId, { coreId, connectionId: connection.id, finish });
      try { connection.sendEvent('collaboration.bridge.request', { ...envelope, requestId }); }
      catch { finish(unavailable('owner app connection closed')); }
    });
  }

  reply(requestId: string, response: CoordinationBridgeResponse, connection: Connection): { ok: true } {
    const request = this.pending.get(requestId);
    if (!request || request.connectionId !== connection.id) throw refused('requestId: expected a request sent to this owner connection');
    if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599
      || typeof response.body !== 'string' || Buffer.byteLength(response.body) > MAX_BODY
      || typeof response.signature !== 'string' || response.signature.length > 1000) {
      throw invalidParams('response: expected HTTP status, body up to 262144 bytes and signature up to 1000 characters');
    }
    request.finish(response);
    return { ok: true };
  }

  revoke(coreId: string): void {
    this.routes.delete(coreId);
    for (const request of this.pending.values()) if (request.coreId === coreId) request.finish(refused('machine permission revoked'));
  }

  disconnect(connectionId: string): void {
    for (const [coreId, routes] of this.routes) {
      routes.delete(connectionId);
      if (!routes.size) this.routes.delete(coreId);
    }
    for (const request of this.pending.values()) if (request.connectionId === connectionId) request.finish(unavailable('owner app connection closed'));
  }

  close(): void {
    this.routes.clear();
    for (const request of this.pending.values()) request.finish(unavailable('the core is stopping'));
  }
}
