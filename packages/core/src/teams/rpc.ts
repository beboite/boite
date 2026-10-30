/** The team methods (`docs/teams.md`). Who may call which is in `access.ts`; each refuses while the `teams` experiment is off. */
import type { Core } from '../core.ts';
import { invalidParams } from '../errors.ts';

export function registerTeams(core: Core): void {
  const teams = () => core.teams;
  const object = <T>(params: T | undefined | null): T => {
    if (params === null || typeof params !== 'object') throw invalidParams('params: expected an object');
    return params;
  };
  core.router.register('teams.list', params => ({ teams: teams().list(object(params ?? {})) }));
  core.router.register('teams.create', params => teams().create(object(params)));
  core.router.register('teams.update', params => teams().update(object(params)));
  core.router.register('teams.archive', params => teams().archive(object(params)));
  core.router.register('teams.members.add', params => teams().addMember(object(params)));
  core.router.register('teams.members.remove', params => teams().removeMember(object(params)));
  core.router.register('teams.pause', params => teams().pause(object(params)));
  core.router.register('teams.post', params => teams().ownerPost(object(params)));
  core.router.register('teams.read', params => teams().read(object(params)));
  core.router.register('teams.say', params => teams().say(object(params)));
  core.router.register('teams.dm', params => teams().dm(object(params)));
  core.router.register('teams.propose', params => teams().propose(object(params)));
  core.router.register('teams.invite', params => teams().invite(object(params)));
  core.router.register('teams.leave', params => teams().leave(object(params)));
}
