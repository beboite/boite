import type { Core } from '../core.ts';
import { refused } from '../errors.ts';

/** Admission epochs prevent a removed and rejoined core from inheriting a saved relay. */
export function memberAdmission(core: Core, memberId: string): string {
  const group = core.group.view('owner');
  const member = group?.cores.find(entry => entry.coreId === memberId);
  const self = group?.cores.find(entry => entry.coreId === group.self);
  if (!group || !member || !self || memberId === group.self) throw refused('member: expected a current group admission');
  return JSON.stringify([group.id, self.epoch, member.epoch]);
}

/** Fence the exact contact, group admission and project policy across asynchronous transfers. */
export function projectAdmission(core: Core, peerId: string, memberId: string, projectId: string): string {
  const contact = core.contacts.find(peerId);
  const grant = contact?.grants.find(g => g.machine === memberId && g.projectId === projectId);
  if (!contact || !grant) throw refused('project: expected the contact current member project grant');
  return JSON.stringify([memberAdmission(core, memberId), contact.addedAt, grant]);
}
