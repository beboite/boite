/** Owner and agent RPC entry points; coordination owns the permissions and delivery. */
import type { Core } from './core.ts';
import type { RpcParams, CoordinationBridgeResponse } from '@boite/contracts';
import { invalidParams, refused } from './errors.ts';
import { boundedBody, MAX_BODY, ROUTE } from './coordination-wire.ts';

/** Forward only the original signed envelope; this path grants no peer permission. */
export async function forwardCoordination(core: Core, params: RpcParams<'collaboration.bridge.forward'>): Promise<CoordinationBridgeResponse> {
  const coreId = params.coreId;
  if (typeof coreId !== 'string' || !coreId.trim() || coreId.length > 100) throw invalidParams('coreId: expected 1 to 100 characters');
  if (typeof params.body !== 'string' || Buffer.byteLength(params.body) > MAX_BODY) throw invalidParams('body: expected at most 262144 bytes');
  if (typeof params.signature !== 'string' || params.signature.length > 1000) throw invalidParams('signature: expected at most 1000 characters');
  const response = await core.coordination.http(new Request(`http://127.0.0.1${ROUTE}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-boite-peer': coreId, 'x-boite-signature': params.signature }, body: params.body }));
  return { status: response.status, body: await boundedBody(response.body), signature: response.headers.get('x-boite-signature') ?? '' };
}

export function registerCoordination(core: Core): void {
  core.router.register('collaboration.get', p => core.coordination.get(p.threadId));
  core.router.register('collaboration.configure', p => core.coordination.configure(p.threadId, p.config));
  core.router.register('collaboration.directory', p => core.coordination.directory(p.threadId));
  core.router.register('collaboration.send', p => core.coordination.send(p));
  core.router.register('collaboration.search', p => core.coordination.search(p.threadId, p.query));
  core.router.register('collaboration.read', p => core.coordination.read(p.threadId, p.target, p.limit, p.before));
  core.router.register('collaboration.wait', (p, ctx) => core.coordination.wait(p.threadId, p.from, p.timeoutMs, ctx.connection));
  core.router.register('collaboration.identity', () => core.coordination.identity());
  core.router.register('collaboration.peers', () => core.coordination.peers());
  core.router.register('collaboration.check', p => core.coordination.check(p.coreId));
  core.router.register('collaboration.trust', p => core.coordination.trust(p.peer));
  core.router.register('collaboration.untrust', p => core.coordination.untrust(p.coreId));
  core.router.register('collaboration.bridge.register', (p, ctx) => {
    // A contact's route is the link its own core keeps, never an owner app.
    if (core.contacts.has(p.coreId) || !core.coordination.trusted().some(peer => peer.coreId === p.coreId)) throw refused('coreId: expected a machine trusted for coordination');
    return core.coordination.bridge.register(p.coreId, p.enabled, ctx.connection);
  });
  core.router.register('collaboration.bridge.forward', p => core.coordination.forward(p));
  core.router.register('collaboration.bridge.reply', (p, ctx) => core.coordination.bridge.reply(p.requestId, p.response, ctx.connection));
}
