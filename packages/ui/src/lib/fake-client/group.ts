/** The group of machines: one roster shared by the fake cores of this page that joined it. */
import { GRANT_TTL_MS, GROUP_INVITE_PREFIX, GROUP_MAX_CORES, GROUP_TICKET_TTL_MS, RpcErrorCode, type Group, type GroupCore, type GroupDevice } from '@boite/contracts';
import { RpcFailure } from '../client';
import { fakeCore } from './coordination';
import type { FakeContext, FakeMethods } from './context';

/** What the members of one fake group share. Each context points at the roster of the group it is in. */
export interface FakeRoster {
  id: string;
  name: string;
  cores: GroupCore[];
  devices: GroupDevice[];
  /** Grants still good, each with its expiry. */
  invites: Map<string, number>;
}

const refuse = (message: string, field?: string) =>
  new RpcFailure({ code: RpcErrorCode.Refused, message, ...(field === undefined ? {} : { data: { field } }) });
const invalid = (message: string, field: string) => new RpcFailure({ code: RpcErrorCode.InvalidParams, message, data: { field } });

function card(ctx: FakeContext): GroupCore {
  return { coreId: ctx.identity.coreId, name: ctx.identity.name, os: ctx.core.os, addresses: [ctx.identity.url] };
}

function view(ctx: FakeContext): Group | null {
  const roster = ctx.roster;
  if (roster === null) return null;
  return {
    id: roster.id,
    name: roster.name,
    self: ctx.identity.coreId,
    cores: structuredClone(roster.cores),
    devices: ctx.bus.principal === 'owner' ? structuredClone(roster.devices) : []
  };
}

function required(ctx: FakeContext): FakeRoster {
  if (ctx.roster === null) throw refuse('this machine belongs to no group');
  return ctx.roster;
}

/** Every fake core of the roster hears the change, as members do once they exchanged it. */
function announce(roster: FakeRoster, also: FakeContext[] = []): void {
  const heard = new Set<FakeContext>(also);
  for (const core of roster.cores) {
    const member = fakeCore(core.coreId);
    if (member !== undefined) heard.add(member);
  }
  for (const member of heard) member.emit('group.updated', {});
}

export function groupMethods(ctx: FakeContext) {
  return {
    'group.get': async () => view(ctx),
    'group.create': async (params) => {
      if (ctx.roster !== null) throw refuse(`this machine already belongs to the group ${ctx.roster.name}; leave it before starting another`);
      const name = typeof params?.name === 'string' ? params.name.trim() : '';
      if (!name || name.length > 80) throw invalid('name: expected 1 to 80 characters', 'name');
      ctx.roster = { id: `grp_fake_${++ctx.seq}`, name, cores: [card(ctx)], devices: [], invites: new Map() };
      ctx.emit('group.updated', {});
      return view(ctx)!;
    },
    'group.invite': async () => {
      const roster = required(ctx);
      const grant = `fake-invite-${++ctx.seq}`;
      const expiresAt = ctx.now() + GRANT_TTL_MS;
      roster.invites.set(grant, expiresAt);
      const body = JSON.stringify({ v: 1, g: roster.id, n: roster.name, c: ctx.identity.coreId, a: [ctx.identity.url], t: grant });
      return { invite: GROUP_INVITE_PREFIX + btoa(body), expiresAt };
    },
    'group.join': async (params) => {
      if (ctx.roster !== null) throw refuse(`this machine already belongs to the group ${ctx.roster.name}; leave it before joining another`);
      const text = typeof params?.invite === 'string' ? params.invite.trim() : '';
      let invite: { g?: unknown; c?: unknown; t?: unknown };
      try {
        if (!text.startsWith(GROUP_INVITE_PREFIX)) throw new Error('prefix');
        invite = JSON.parse(atob(text.slice(GROUP_INVITE_PREFIX.length))) as typeof invite;
      } catch {
        throw invalid(`invite: expected an invitation starting with ${GROUP_INVITE_PREFIX}, as "Invite a machine" gives it`, 'invite');
      }
      if (invite.c === ctx.identity.coreId) throw refuse('this invitation was made on this machine; paste it on the machine that joins', 'invite');
      const host = typeof invite.c === 'string' ? fakeCore(invite.c) : undefined;
      const roster = host?.roster ?? null;
      if (roster === null || roster.id !== invite.g) throw refuse('no machine answered the invitation: it may be off, or this machine cannot reach those addresses', 'invite');
      const expiresAt = typeof invite.t === 'string' ? roster.invites.get(invite.t) : undefined;
      if (expiresAt === undefined || expiresAt <= ctx.now()) throw refuse('the invitation was already used by another machine, expired, or never issued', 'invite');
      if (roster.cores.length >= GROUP_MAX_CORES) throw refuse(`a group holds at most ${GROUP_MAX_CORES} machines`, 'invite');
      roster.invites.delete(invite.t as string);
      roster.cores.push(card(ctx));
      ctx.roster = roster;
      announce(roster);
      return view(ctx)!;
    },
    'group.leave': async () => {
      const roster = required(ctx);
      roster.cores = roster.cores.filter((core) => core.coreId !== ctx.identity.coreId);
      roster.devices = roster.devices.filter((device) => !device.id.startsWith(`${ctx.identity.coreId}:`));
      ctx.roster = null;
      announce(roster, [ctx]);
      return { ok: true };
    },
    'group.remove': async (params) => {
      const roster = required(ctx);
      const coreId = params?.coreId;
      if (!roster.cores.some((core) => core.coreId === coreId)) throw refuse(`${String(coreId)} is not a machine of this group`, 'coreId');
      if (coreId === ctx.identity.coreId) throw refuse('group.remove names another machine; group.leave takes this one out', 'coreId');
      const removed = fakeCore(coreId);
      roster.cores = roster.cores.filter((core) => core.coreId !== coreId);
      roster.devices = roster.devices.filter((device) => !device.id.startsWith(`${coreId}:`));
      if (removed !== undefined && removed.roster === roster) removed.roster = null;
      announce(roster, removed === undefined ? [] : [removed]);
      return view(ctx)!;
    },
    'group.ticket': async (params) => {
      const roster = required(ctx);
      const target = roster.cores.find((core) => core.coreId === params?.coreId);
      if (target === undefined || target.coreId === ctx.identity.coreId) throw refuse(`${String(params?.coreId)} is not another machine of this group`, 'coreId');
      return { ticket: `fake-ticket-${++ctx.seq}`, coreId: target.coreId, addresses: [...target.addresses], expiresAt: ctx.now() + GROUP_TICKET_TTL_MS };
    },
  } satisfies Partial<FakeMethods>;
}
