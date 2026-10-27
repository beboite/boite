/** Routing data names only the two disclosed endpoints. It never forwards owner RPC authority. */
import type { SharedProjectPeerRequest, SharedProjectRef } from '@boite/contracts';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';
import { projectRef, sameProject } from './project-policy.ts';
import { projectAdmission } from './admission.ts';

export function projectRoute(raw: unknown): {source: SharedProjectRef; target: SharedProjectRef} | null {
  const p = raw as SharedProjectPeerRequest;
  if (p?.method === 'offer') return {source: projectRef(p.project?.projects?.[0]), target: projectRef(p.project?.projects?.[1])};
  return p?.route ? {source: projectRef(p.route.source), target: projectRef(p.route.target)} : null;
}

/** A member's grant and negotiated features, from the exact gateway which owns this endpoint. */
export function projectContact(core: Core, local: SharedProjectRef, peerId: string) {
  const self = core.coordination.card().coreId;
  if (local.coreId !== self) return undefined;
  if (local.ownerCoreId === self) return core.contacts.find(peerId);
  return core.contacts.members.relayedOf(peerId).find(entry => entry.via === local.ownerCoreId);
}

export async function receiveProject(core: Core, peerId: string, payload: unknown, relayed: boolean): Promise<unknown> {
  const route = projectRoute(payload), self = core.coordination.card().coreId;
  if (route) {
    if (route.source.ownerCoreId !== peerId) throw refused('route.source: expected the authenticated contact owner');
    if (route.target.coreId !== self) {
      if (relayed || route.target.ownerCoreId !== self) throw refused('route.target: expected this gateway and its granted member');
      const member = core.contacts.members.member(route.target.coreId);
      const contact = core.contacts.find(peerId);
      if (!member || !contact?.grants.some(g => g.machine === member.coreId && g.projectId === route.target.projectId)) throw refused('route.target: member project is not granted to this contact');
      const admission = projectAdmission(core, peerId, member.coreId, route.target.projectId);
      const result = await core.contacts.members.requestProject(member, peerId, payload);
      if (projectAdmission(core, peerId, member.coreId, route.target.projectId) !== admission) throw refused('route.target: member or project grant changed during request');
      return result;
    }
    if (!projectContact(core, route.target, peerId)) throw refused('route.target: expected a current contact admission on this endpoint');
  } else if (relayed) throw refused('route: member requests require explicit canonical endpoints');
  return core.sharedProjects.receive(peerId, payload);
}

export function checkProjectRoute(value: unknown, local: SharedProjectRef, remote: SharedProjectRef): void {
  const route = projectRoute(value);
  if (route && (!sameProject(route.source, remote) || !sameProject(route.target, local))) throw refused('route: expected the two endpoints of this association');
  if (!route && (local.coreId !== local.ownerCoreId || remote.coreId !== remote.ownerCoreId)) throw refused('route: member requests require explicit canonical endpoints');
}
