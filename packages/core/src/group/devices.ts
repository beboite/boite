/*
 * The devices of a group, as a member's push sees them: which of the keys this
 * machine issued through the group stand for a device another member paired,
 * and which device ids are this machine's own.
 */
import type { CoordinationPeer } from '@boite/contracts';
import type { Core } from '../core.ts';
import { homeOf } from './roster.ts';

/**
 * The device a key this machine issued through the group stands for, when that
 * device was paired with another member that still is one: the page it
 * installed, and its push subscription, are on that member.
 */
export function deviceElsewhere(core: Core, sessionId: string): { home: CoordinationPeer; device: string } | null {
  const member = core.group.owns(sessionId);
  if (member === undefined || !member.startsWith('device:')) return null;
  const device = member.slice('device:'.length);
  // Listed live: a revoked device is out, whichever member revoked it.
  if (!core.group.view('owner')?.devices.some((entry) => entry.id === device)) return null;
  const home = core.group.peers().find((peer) => peer.coreId === homeOf(device));
  return home === undefined ? null : { home, device };
}

/** This machine's session for a device the roster lists as its own; null for any other id. */
export function ownDevice(core: Core, device: unknown): string | null {
  const group = core.group.view('owner');
  if (typeof device !== 'string' || group === null || homeOf(device) !== group.self) return null;
  if (!group.devices.some((entry) => entry.id === device)) return null;
  return device.slice(device.indexOf(':') + 1);
}
