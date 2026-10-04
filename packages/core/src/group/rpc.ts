/** The methods a client calls on the group of its core. Who may call which is in `access.ts`. */
import type { Core } from '../core.ts';

export function registerGroupMethods(core: Core): void {
  core.router.register('group.get', (_params, ctx) => core.group.view(ctx.connection.identity.principal));
  core.router.register('group.create', (params) => core.group.create(params?.name));
  core.router.register('group.rename', (params) => core.group.rename(params?.name));
  core.router.register('group.invite', () => core.group.invite());
  core.router.register('group.join', (params) => core.group.join(params?.invite));
  core.router.register('group.leave', () => core.group.leave());
  core.router.register('group.remove', (params) => core.group.remove(params?.coreId));
  core.router.register('group.ticket', (params, ctx) => core.group.ticket(params?.coreId, ctx.connection.identity, params?.url));
}
