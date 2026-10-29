/** The group of machines: one roster shared by the fake cores of this page that joined it. */
import { DEVICE_LINK_JOIN, GRANT_TTL_MS, GROUP_INVITE_PREFIX, GROUP_MAX_CORES, GROUP_TICKET_TTL_MS, RpcErrorCode, type Group, type GroupCore, type GroupDevice } from '@boite/contracts';
import { RpcFailure } from '../client';
import { usableAddresses } from '../group-addresses';
import { secureId } from '../secure-id';
import { fakeCore, migratePeer } from './coordination';
import type { FakeContext, FakeMethods } from './context';

/** What the members of one fake group share. Each context points at the roster of the group it is in. */
export interface FakeRoster {
  id: string;
  name: string;
  cores: GroupCore[];
  devices: GroupDevice[];
  /** The member the others take their settings from. */
  settingsHome?: string;
  /** Grants still good, each with its expiry. */
  invites: Map<string, number>;
}

const refuse = (message: string, field?: string) =>
  new RpcFailure({ code: RpcErrorCode.Refused, message, ...(field === undefined ? {} : { data: { field } }) });
const invalid = (message: string, field: string) => new RpcFailure({ code: RpcErrorCode.InvalidParams, message, data: { field } });

function card(ctx: FakeContext): GroupCore {
  return { coreId: ctx.identity.coreId, name: ctx.identity.name, os: ctx.core.os, addresses: [ctx.identity.url], epoch: 1 };
}

function view(ctx: FakeContext): Group | null {
  const roster = ctx.roster;
  if (roster === null) return null;
  return {
    id: roster.id,
    name: roster.name,
    self: ctx.identity.coreId,
    cores: structuredClone(roster.cores),
    devices: ctx.bus.principal === 'owner' ? structuredClone(roster.devices) : [],
    ...(roster.settingsHome !== undefined && roster.cores.some(core => core.coreId === roster.settingsHome) ? { settingsHome: roster.settingsHome } : {})
  };
}

/** The invitation a pasted device link carries after `#join=`, or the text itself. */
function inviteOf(text: string): string {
  const at = text.indexOf(`#${DEVICE_LINK_JOIN}=`);
  if (at < 0) return text;
  try { return decodeURIComponent(text.slice(at + DEVICE_LINK_JOIN.length + 2)); } catch { return text; }
}

function newRoster(ctx: FakeContext, name: string): FakeRoster {
  return { id: `grp_${secureId()}`, name, cores: [card(ctx)], devices: [], invites: new Map() };
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
  for (const member of heard) {
    for (const [coreId, grant] of member.groupReads) {
      if (member.roster !== roster || !roster.cores.some(core => core.coreId === coreId && grant.epoch === core.epoch)) member.groupReads.delete(coreId);
    }
    if (member.roster === roster) for (const core of roster.cores) migratePeer(member, core.coreId);
    member.emit('group.updated', {});
  }
}

export function groupMethods(ctx: FakeContext) {
  return {
    'group.get': async () => view(ctx),
    'group.rename': async (params) => {
      const roster = required(ctx);
      const name = typeof params?.name === 'string' ? params.name.trim() : '';
      if (!name || name.length > 80) throw invalid('name: expected 1 to 80 characters', 'name');
      if (name === roster.name) return view(ctx)!;
      roster.name = name;
      announce(roster);
      return view(ctx)!;
    },
    'group.settingsHome': async (params) => {
      const roster = required(ctx);
      const coreId = params?.coreId;
      if (coreId !== null && (typeof coreId !== 'string' || !roster.cores.some(core => core.coreId === coreId))) {
        throw invalid('coreId: expected the id of a machine of this group, or null', 'coreId');
      }
      if ((roster.settingsHome ?? null) === coreId) return view(ctx)!;
      if (coreId === null) delete roster.settingsHome;
      else roster.settingsHome = coreId;
      announce(roster);
      return view(ctx)!;
    },
    'group.create': async (params) => {
      if (ctx.roster !== null) throw refuse(`this machine already belongs to the group ${ctx.roster.name}; leave it before starting another`);
      const name = typeof params?.name === 'string' ? params.name.trim() : '';
      if (!name || name.length > 80) throw invalid('name: expected 1 to 80 characters', 'name');
      ctx.roster = newRoster(ctx, name);
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
      // A group of this machine alone gives way, and its devices come along.
      const alone = ctx.roster === null || ctx.roster.cores.every((core) => core.coreId === ctx.identity.coreId);
      if (!alone) throw refuse(`this machine already belongs to the group ${ctx.roster!.name}; leave it before joining another`);
      const carried = ctx.roster?.devices ?? [];
      const text = typeof params?.invite === 'string' ? inviteOf(params.invite.trim()) : '';
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
      for (const device of carried) if (!roster.devices.some((known) => known.id === device.id)) roster.devices.push({ ...device, by: ctx.identity.coreId });
      ctx.roster = roster;
      announce(roster);
      return view(ctx)!;
    },
    'group.leave': async () => {
      const roster = required(ctx);
      roster.cores = roster.cores.filter((core) => core.coreId !== ctx.identity.coreId);
      roster.devices = roster.devices.filter((device) => !device.id.startsWith(`${ctx.identity.coreId}:`));
      if (roster.settingsHome === ctx.identity.coreId) delete roster.settingsHome;
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
      // A default machine that leaves is no default when it comes back.
      if (roster.settingsHome === coreId) delete roster.settingsHome;
      if (removed !== undefined && removed.roster === roster) removed.roster = null;
      announce(roster, removed === undefined ? [] : [removed]);
      return view(ctx)!;
    },
    'group.ticket': async (params) => {
      const roster = required(ctx);
      const target = roster.cores.find((core) => core.coreId === params?.coreId);
      if (target === undefined || target.coreId === ctx.identity.coreId) throw refuse(`${String(params?.coreId)} is not another machine of this group`, 'coreId');
      // The real core's rule: HTTPS when the machine has one, else an address written as numbers.
      const usable = usableAddresses(target.addresses, false);
      const at = params?.url === undefined ? usable[0] : usable.find((address) => address === params.url);
      if (at === undefined) throw refuse(`url: expected an address of ${target.name} a key may be sent to, HTTPS when it has one and written as numbers otherwise`, 'url');
      return { ticket: `fake-ticket-${++ctx.seq}`, coreId: target.coreId, addresses: [...target.addresses], url: at, expiresAt: ctx.now() + GROUP_TICKET_TTL_MS };
    },
    'group.addDevice': async () => {
      if (ctx.roster === null) {
        ctx.roster = newRoster(ctx, ctx.identity.name);
        ctx.emit('group.updated', {});
      }
      const roster = ctx.roster;
      const grant = `fake-invite-${++ctx.seq}`;
      const expiresAt = ctx.now() + GRANT_TTL_MS;
      roster.invites.set(grant, expiresAt);
      const invite = GROUP_INVITE_PREFIX + btoa(JSON.stringify({ v: 1, g: roster.id, n: roster.name, c: ctx.identity.coreId, a: [ctx.identity.url], t: grant }));
      // The real core's link: its public address, else where it listens. `?lan=off` is a fresh install that listens on itself.
      const lanOff = typeof location !== 'undefined' && new URLSearchParams(location.search).get('lan') === 'off' && !ctx.settings.listenOnLan;
      const origin = ctx.settings.publicUrl ?? (lanOff ? 'http://127.0.0.1:8777' : 'http://192.168.1.20:8777');
      return {
        url: `${origin}/?grant=fake-grant-${ctx.seq}#${DEVICE_LINK_JOIN}=${encodeURIComponent(invite)}`,
        expiresAt
      };
    },
    'group.revokeDevice': async (params) => {
      const roster = required(ctx);
      if (!roster.devices.some((device) => device.id === params?.id)) throw refuse(`${String(params?.id)} is not a device of this group`, 'id');
      roster.devices = roster.devices.filter((device) => device.id !== params?.id);
      announce(roster);
      return view(ctx)!;
    },
    'group.enrollDevice': async (params) => {
      if (ctx.roster === null) ctx.roster = newRoster(ctx, ctx.identity.name);
      const id = `fake-device-${String(params?.publicKey ?? '').slice(0, 8) || ++ctx.seq}`;
      if (!ctx.roster.devices.some((device) => device.id === id)) ctx.roster.devices.push({ id, name: params?.name ?? 'device', role: 'device', by: ctx.identity.coreId, addedAt: ctx.now() });
      announce(ctx.roster);
      return { id, group: view(ctx)! };
    },
  } satisfies Partial<FakeMethods>;
}
