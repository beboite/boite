/** Contact provenance is minted at authenticated RPC admission and checked again on sealed delivery. */
import type { AgentAddress, AgentContact, AgentLetter, CoordinationPeer } from '@boite/contracts';
import type { Core } from '../core.ts';
import type { Connection } from '../router.ts';
import { refused } from '../errors.ts';
import { sameProject, threadRef, projectAddress } from './project-policy.ts';

export async function outgoingContact(core: Core, from: AgentContact, to: AgentAddress, human: boolean, connection?: Connection): Promise<Partial<AgentLetter>> {
  const contact = core.contacts.find(to.coreId) ?? core.contacts.members.relayedOf(to.coreId)[0];
  if (human && (!contact || contact.capabilities?.humanLetters !== 1)) throw refused('to.coreId: expected a contact with negotiated humanLetters version 1');
  if (!contact) return {};
  let scope: Partial<AgentLetter> = {};
  if (core.sharedProjects.hasContact(to.coreId)) {
    let found = false;
    for (const shared of core.sharedProjects.forThread(from.threadId, to.coreId)) {
      const p = { threadId: from.threadId, sharedProjectId: shared.id };
      const ctx = core.sharedProjects.scope(p, connection);
      const directory = await core.sharedProjects.threads(p, connection);
      if (!directory.threads.some(t => sameProject(t.ref.project, ctx.remote) && t.ref.address.coreId === to.coreId && t.ref.address.threadId === to.threadId)) continue;
      scope = { sharedProjectId: shared.id, from: { ...from, sharedThread: { project: ctx.local, threadId: from.threadId, address: projectAddress(ctx.local, from.threadId) } } };
      found = true;
      break;
    }
    if (!found) throw refused('to: expected an allowed thread of this source project association');
  }
  const sender = scope.from ?? from;
  if (human) { const { agent: _model, ...person } = sender; scope = { ...scope, from: person, origin: 'contact-human' }; }
  return scope;
}

/** Runs both at receipt and immediately before provider delivery, so queued mail cannot outlive consent. */
export function incomingContact(core: Core, letter: AgentLetter, peer?: CoordinationPeer): Partial<AgentLetter> {
  const contact = peer ? (core.contacts.find(peer.coreId) ?? core.contacts.members.relayedOf(peer.coreId)[0]) : undefined;
  const human = letter.origin === 'contact-human';
  if (human && (!contact || contact.capabilities?.humanLetters !== 1)) throw refused('letter.origin: contact-human requires negotiated humanLetters support');
  if (!contact) return {};
  if (letter.origin !== undefined && !['agent', 'contact-human'].includes(letter.origin)) throw refused('letter.origin: expected contact agent or attested contact-human');
  let sender = letter.from;
  if (core.sharedProjects.hasContact(contact.coreId)) {
    const shared = core.sharedProjects.require(letter.sharedProjectId!);
    core.sharedProjects.assertActive(shared);
    const { local, remote } = core.sharedProjects.endpoints(shared);
    const source = threadRef(sender.sharedThread);
    if (remote.ownerCoreId !== contact.coreId || !sameProject(source.project, remote) || source.address.coreId !== peer!.coreId || source.address.threadId !== sender.threadId
      || core.threads.require(letter.to.threadId).projectId !== local.projectId) throw refused('letter.sharedProjectId: expected the exact associated source and destination');
    sender = { ...sender, sharedThread: source };
  } else if (letter.sharedProjectId !== undefined || sender.sharedThread !== undefined) throw refused('letter.sharedProjectId: association unavailable');
  if (human) { const { agent: _model, ...person } = sender; sender = person; }
  else core.contacts.checkAttestedTier(sender.agent);
  return { from: sender, ...(human ? { origin: 'contact-human' as const } : {}), ...(letter.sharedProjectId ? { sharedProjectId: letter.sharedProjectId } : {}) };
}
