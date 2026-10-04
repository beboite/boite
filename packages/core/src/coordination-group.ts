import type { CoordinationPeer } from '@boite/contracts';
import type { Core } from './core.ts';

const SETTING = 'coordination:group-reads';
type Grants = Record<string, { groupId: string; epoch: number; selfEpoch: number }>;
const grants = (core: Core): Grants => (core.journal.getSetting(SETTING) as Grants | undefined) ?? {};

/** Read grants do not confer trust: they apply only to the same live group admission. */
export function groupPeers(core: Core): CoordinationPeer[] {
  const group = core.group.view('owner');
  const allowed = grants(core);
  const selfEpoch = group?.cores.find(entry => entry.coreId === group.self)?.epoch;
  return core.group.peers().map(peer => {
    const grant = allowed[peer.coreId];
    const member = group?.cores.find(entry => entry.coreId === peer.coreId);
    return { ...peer, readThreads: grant?.groupId === group?.id && grant?.epoch === member?.epoch && grant?.selfEpoch === selfEpoch };
  });
}

export function dropGroupRead(core: Core, coreId: string): void {
  const allowed = grants(core);
  if (!(coreId in allowed)) return;
  delete allowed[coreId];
  core.journal.setSetting(SETTING, allowed);
}

/** Replace pairwise trust without losing an explicit permission for this admission. */
export function migrateGroupPeer(core: Core, peer: CoordinationPeer): void {
  const group = core.group.view('owner');
  const member = group?.cores.find(entry => entry.coreId === peer.coreId);
  const self = group?.cores.find(entry => entry.coreId === group.self);
  if (!group || !member || !self) return;
  const allowed = grants(core);
  if (peer.readThreads) allowed[peer.coreId] = { groupId: group.id, epoch: member.epoch, selfEpoch: self.epoch };
  else delete allowed[peer.coreId];
  core.journal.setSetting(SETTING, allowed);
  core.coordination.untrust(peer.coreId, true);
}
