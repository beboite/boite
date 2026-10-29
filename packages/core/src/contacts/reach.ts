/*
 * What a contact reaches on this core: the threads of the projects opened to
 * it, here or through the member of the group it is linked to, and a thread
 * that wrote to it in the last 7 days. And the model tier its traffic takes.
 */
import type { ContactGrant, ModelTier } from '@boite/contracts';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';
import type { ContactStore } from './store.ts';
import { attestedTier, modelTier, tierAllowed } from './tier.ts';

const RECENT = 'contacts:recent';
/** How long a thread that wrote to a contact may hear back from it, outside the projects opened to it. */
export const REPLY_WINDOW_MS = 7 * 24 * 3_600_000;

export class ContactReach {
  readonly #core: Core;
  readonly #contacts: ContactStore;

  constructor(core: Core, contacts: ContactStore) {
    this.#core = core;
    this.#contacts = contacts;
  }

  /** This core's projects opened to the contact: through its own link, or through the member the contact is linked to. */
  #grantsHere(coreId: string): Pick<ContactGrant, 'projectId' | 'readThreads'>[] {
    return [...(this.#contacts.find(coreId)?.grants.filter(grant => !grant.machine) ?? []), ...this.#contacts.members.relayedOf(coreId).flatMap(entry => entry.grants)]
      .filter(grant => !this.#contacts.policyRevoked(coreId, grant.projectId));
  }

  #grantFor(coreId: string, threadId: string): Pick<ContactGrant, 'projectId' | 'readThreads'> | undefined {
    const projectId = this.#core.journal.getThread(threadId)?.projectId;
    if (!projectId) return undefined;
    const grants = this.#grantsHere(coreId).filter(grant => grant.projectId === projectId);
    return grants.find(grant => grant.readThreads) ?? grants[0];
  }

  /** This core's projects opened to this contact. */
  granted(coreId: string): string[] { return [...new Set(this.#grantsHere(coreId).map(grant => grant.projectId))]; }

  /** A contact's letter may reach this thread: its project is opened to the contact, or the thread wrote to it lately. */
  mayReach(coreId: string, threadId: string): boolean {
    const thread = this.#core.journal.getThread(threadId);
    if (!thread || thread.archived || !this.#contacts.isContact(coreId)) return false;
    if (thread.projectId && this.#contacts.policyRevoked(coreId, thread.projectId)) return false;
    if (this.#grantFor(coreId, threadId)) return true;
    const at = this.#recent()[threadId]?.[coreId];
    return typeof at === 'number' && Date.now() - at <= REPLY_WINDOW_MS;
  }

  mayRead(coreId: string, threadId: string): boolean { return this.#grantFor(coreId, threadId)?.readThreads === true; }

  #recent(): Record<string, Record<string, number>> { return (this.#core.journal.getSetting(RECENT) as Record<string, Record<string, number>> | undefined) ?? {}; }

  /** This thread wrote to a contact: it may hear back for 7 days. */
  noteSent(threadId: string, coreId: string): void {
    const now = Date.now();
    const recent = this.#recent();
    for (const [thread, contacts] of Object.entries(recent)) {
      for (const [id, at] of Object.entries(contacts)) if (now - at > REPLY_WINDOW_MS || !this.#contacts.isContact(id)) delete contacts[id];
      if (Object.keys(contacts).length === 0) delete recent[thread];
    }
    recent[threadId] = { ...recent[threadId], [coreId]: now };
    this.#core.journal.setSetting(RECENT, recent);
  }

  /** The threads `which` names no longer hear back from this contact. */
  forgetReplies(coreId: string, which: (threadId: string) => boolean): void {
    const recent = this.#recent();
    let changed = false;
    for (const [thread, contacts] of Object.entries(recent)) {
      if (!(coreId in contacts) || !which(thread)) continue;
      delete contacts[coreId];
      if (Object.keys(contacts).length === 0) delete recent[thread];
      changed = true;
    }
    if (changed) this.#core.journal.setSetting(RECENT, recent);
  }

  /** The tier the owner set for this contact's traffic: on the machine the contact is linked to, when that is another member. */
  #minTierFor(coreId: string | undefined): ModelTier {
    const relayed = coreId && !this.#contacts.has(coreId) ? this.#contacts.members.relayedOf(coreId)[0] : undefined;
    return relayed?.minTier ?? this.#contacts.settings().minTier;
  }

  /** Refused when this thread's model is below the tier the owner set for contact traffic. */
  checkSendTier(threadId: string, coreId?: string): void {
    const thread = this.#core.threads.require(threadId);
    const tier = modelTier(thread.providerId, thread.model);
    const minTier = this.#minTierFor(coreId);
    if (!tierAllowed(tier, minTier)) {
      throw refused(`threadId: this thread runs ${thread.providerId} ${thread.model ?? '(default model)'}, tier ${tier}; contacts take tier ${minTier} or better, set in Contacts`, { field: 'threadId', expected: `a thread on a model of tier ${minTier} or better` });
    }
  }

  /** Refused when the model a contact's core attests for its agent is below this owner's tier. */
  checkAttestedTier(agent: string | undefined, coreId?: string): void {
    const tier = attestedTier(agent);
    const minTier = this.#minTierFor(coreId);
    if (!tierAllowed(tier, minTier)) throw refused(`from.agent: ${agent ?? 'an unknown model'} is tier ${tier}; this owner takes tier ${minTier} or better from contacts`);
  }

  /** A member no longer opens these of its projects to a contact another member holds, or none (`null`). */
  closed(coreId: string, projectIds: string[] | null): void {
    // The contact's own link to this core, or another member still relaying it, keeps its replies.
    if (projectIds !== null) this.forgetReplies(coreId, threadId => projectIds.includes(this.#core.journal.getThread(threadId)?.projectId ?? ''));
    else if (!this.#contacts.has(coreId) && this.#contacts.members.relayedOf(coreId).length === 0) this.forgetReplies(coreId, () => true);
    this.#core.coordination.rejectContactLetters(coreId, 'Project closed to this contact');
  }
}
