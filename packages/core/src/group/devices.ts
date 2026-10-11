/*
 * The devices of a group, as a member's push sees them. A device subscribes
 * to notifications on the machine whose page it installed; the others send
 * theirs to that machine, which pushes them with its own key. A device key
 * says which machine that is in the roster (`push`); a pairing of the older
 * kind is the machine it paired with.
 */
import type { CoordinationPeer } from '@boite/contracts';
import type { Core } from '../core.ts';
import { homeOf } from './roster.ts';

/**
 * The device a session of this machine stands for, when its notifications go
 * through another member that still is one: the page it installed, and its
 * push subscription, are on that member.
 */
export function deviceElsewhere(core: Core, sessionId: string): { home: CoordinationPeer; device: string } | null {
  const keyed = core.group.clients.deviceOf(sessionId);
  if (keyed !== undefined) {
    const at = core.group.clients.pushHome(keyed);
    const home = at === undefined ? undefined : core.group.peers().find((peer) => peer.coreId === at);
    return home === undefined ? null : { home, device: keyed };
  }
  const member = core.group.issuedFor(sessionId);
  if (member === undefined || !member.startsWith('device:')) return null;
  const device = member.slice('device:'.length);
  // The roster that lists the device can arrive after its ticket did: the key existing is enough here, since a
  // revocation this machine heard of took the key away, and the home machine pushes only to a device it lists live.
  const home = core.group.peers().find((peer) => peer.coreId === homeOf(device));
  return home === undefined ? null : { home, device };
}

/** This machine's session for a device whose notifications the roster says come through here; null for any other id. */
export function ownDevice(core: Core, device: unknown): string | null {
  const group = core.group.view('owner');
  if (typeof device !== 'string' || group === null) return null;
  if (/^[0-9a-f]{64}$/.test(device)) return core.group.clients.pushHome(device) === group.self ? core.group.clients.sessionOfDevice(device) ?? null : null;
  if (homeOf(device) !== group.self) return null;
  if (!group.devices.some((entry) => entry.id === device)) return null;
  return device.slice(device.indexOf(':') + 1);
}
