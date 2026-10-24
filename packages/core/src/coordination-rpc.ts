/** Owner and agent RPC entry points; coordination owns the permissions and delivery. */
import type { Core } from './core.ts';
import { refused } from './errors.ts';

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
