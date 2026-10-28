/** External correspondence retains its execution authority with the history that consumed it. */
import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import type {AgentLetter} from '@boite/contracts';
import type {Core} from '../core.ts';
import {refused} from '../errors.ts';
import {withLoad} from '../threads/records.ts';
import type {AccessBinding} from './access-scopes.ts';
import {incomingContact} from './human-letters.ts';

/**
 * `peers` are every contact whose mail the history read; `holders` only those
 * whose mail came outside a shared project and holds it. Scopes saved before
 * `holders` existed hold through all their peers. `trusted` are the digests of
 * the letters still waiting when the owner trusted the history; those letters,
 * exactly as they were, no longer hold it.
 */
interface LetterScope {bindings: AccessBinding[]; legacy: boolean; peers: string[]; holders?: string[]; trustedAt?: number; trusted?: string[]}
const checkedHistory = new WeakMap<Core, Set<string>>();

/** The sender chooses a letter's id, so an approval covers its content too. */
function approval(letter: AgentLetter): string {
  return createHash('sha256').update(JSON.stringify([letter.id, letter.from.coreId, letter.from.threadId, letter.contact?.coreId ?? null, letter.origin ?? null, letter.text, letter.replyTo, letter.createdAt, letter.expiresAt])).digest('hex');
}

function storedScope(core: Core, threadId: string): LetterScope | null {
  const saved = core.journal.getSetting(`shared-file-letters:${threadId}`) as LetterScope | null;
  if (saved) return saved;
  let checked = checkedHistory.get(core);
  if (!checked) {checked = new Set(); checkedHistory.set(core, checked);}
  if (checked.has(threadId)) return null;
  checked.add(threadId);
  // Older cores delivered mail without a captured boundary. Never infer a new
  // grant for that history or silently resume its unrestricted native session.
  const rows = core.journal.db.query("SELECT DISTINCT json_extract(data,'$.contact.coreId') AS peer FROM coordination_letters WHERE thread_id=? AND direction='in' AND status IN ('delivered','uncertain') AND json_type(data,'$.contact.coreId')='text'").all(threadId) as {peer: string}[];
  if (!rows.length) return null;
  const scope: LetterScope = {bindings: [], legacy: true, peers: rows.map(r => r.peer), holders: rows.map(r => r.peer)};
  core.journal.setSetting(`shared-file-letters:${threadId}`, scope);
  core.sharedAccess.execution.reconcile();
  return scope;
}

/** The thread and the conversations whose history it continues, nearest first. */
function history(core: Core, threadId: string): string[] {
  const ids: string[] = [];
  let thread = core.journal.getThread(threadId);
  while (thread && !ids.includes(thread.id)) {
    ids.push(thread.id);
    // A remote job starts a fresh session with the remote task and its own
    // captured host grant/checkout. Its host parent supplies the account/profile,
    // never conversation history. Descendants still inherit this job's letters.
    if (core.sharedCompute.journal.worker(thread.id)) break;
    thread = thread.parentThreadId ? core.journal.getThread(thread.parentThreadId) : null;
  }
  return ids;
}

export function letterScope(core: Core, threadId: string): LetterScope {
  const bindings: AccessBinding[] = [], peers = new Set<string>(), holders = new Set<string>();
  let legacy = false;
  for (const id of history(core, threadId)) {
    const scope = storedScope(core, id);
    if (!scope) continue;
    legacy ||= scope.legacy;
    for (const peer of scope.peers) peers.add(peer);
    if (scope.legacy) for (const peer of scope.holders ?? scope.peers) holders.add(peer);
    for (const binding of scope.bindings) if (!bindings.some(b => b.job.sharedProjectId === binding.job.sharedProjectId && b.job.grantRevision === binding.job.grantRevision && b.checkoutPath === binding.checkoutPath)) bindings.push({...binding, threadId});
  }
  return {bindings, legacy, peers: [...peers], holders: [...holders]};
}

/**
 * The contacts whose unassociated mail holds this thread, by name, or null.
 * Such mail has no captured file authority, so every turn and tool is refused
 * until the owner trusts that history.
 */
export function contactHold(core: Core, threadId: string): {contacts: string[]} | null {
  const scope = letterScope(core, threadId);
  if (!scope.legacy) return null;
  const known = core.contacts.peers();
  return {contacts: scope.holders!.map(coreId => known.find(peer => peer.coreId === coreId)?.name ?? coreId.slice(0, 8))};
}

/**
 * The owner accepts the unassociated contact mail this thread's history
 * consumed. Associated mail keeps its captured bindings; a later unassociated
 * letter holds the thread again.
 */
export function trustLetters(core: Core, threadId: string): void {
  core.threads.require(threadId);
  const ids = history(core, threadId);
  const resumed: string[] = [];
  for (const id of ids) {
    const scope = storedScope(core, id);
    if (!scope?.legacy) continue;
    // A refused wake left the holders' letters waiting: the owner trusted them
    // too, not a letter that arrives later.
    const holders = scope.holders ?? scope.peers;
    const waiting = (core.journal.db.query("SELECT data FROM coordination_letters WHERE thread_id=? AND direction='in' AND status='received' AND json_type(data,'$.sharedProjectId') IS NULL").all(id) as {data: string}[])
      .map(row => JSON.parse(row.data) as AgentLetter).filter(letter => letter.contact && letter.expiresAt > Date.now());
    const trusted = waiting.map(approval).filter((digest, index) => scope.trusted?.includes(digest) || holders.includes(waiting[index]!.contact!.coreId));
    core.journal.setSetting(`shared-file-letters:${id}`, {...scope, legacy: false, holders: [], trustedAt: Date.now(), trusted});
    if (trusted.length) resumed.push(id);
  }
  core.sharedAccess.execution.reconcile();
  announceHold(core, ids);
  for (const id of resumed) core.coordination.resumeTrusted(id);
}

/**
 * Every client's row and open view take the hold as it now stands, on these
 * threads and every descendant whose history walks through them. A remote
 * job's history stops at the job, so the walk does not enter one.
 */
function announceHold(core: Core, changed: string[]): void {
  const seen = new Set<string>();
  const queue = [...changed];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const thread = core.journal.getThread(id);
    if (thread) core.bus.emit('thread.updated', {...withLoad(core, thread), contactHold: contactHold(core, id)});
    const children = core.journal.db.query('SELECT id FROM threads WHERE parent_thread_id=?').all(id) as {id: string}[];
    for (const child of children) if (!core.sharedCompute.journal.worker(child.id)) queue.push(child.id);
  }
}

/** Called before wake, steer and hook delivery. Unsupported native sessions never see the letter. */
export function protectLetters(core: Core, threadId: string, letters: AgentLetter[]): void {
  // Core-formatted request answers still contain the contact's untrusted reason.
  const contactMail = letters.filter(l => l.contact);
  if (!contactMail.length) return;
  // A letter the owner trusted while it waited carries no new authority.
  const trusted = storedScope(core, threadId)?.trusted ?? [];
  const external = contactMail.filter(l => l.sharedProjectId || !trusted.includes(approval(l)));
  if (!external.length) return;
  const thread = core.threads.require(threadId);
  const protocol = core.providers.require(thread.providerId).protocol;
  if (!core.sharedAccess.execution.support(protocol, thread.providerId, thread.permissionMode).supported || protocol === 'echo' && thread.permissionMode !== 'default') throw refused('shared file policy: contact letter execution requires a protected provider route');
  const captured = core.sharedAccess.bound(threadId);
  const associations = captured ? [captured, ...(captured.additional ?? [])].map(b => b.job.sharedProjectId) : [];
  if (protocol !== 'echo' && ['queued', 'running', 'waiting'].includes(thread.status)
    && external.some(l => !l.sharedProjectId || !associations.includes(l.sharedProjectId))) {
    throw refused('shared file policy: new contact authority waits until the native turn is idle');
  }
  if (protocol !== 'echo' && !captured) {
    // An ordinary running session has unrestricted tools. Hold the letter until
    // that turn ends; it must never be steered into the old process.
    if (['queued', 'running', 'waiting'].includes(thread.status)) throw refused('shared file policy: contact letter waits for protected native preparation after the local turn');
    core.threads.releaseAgent(threadId);
  }
  const before = JSON.stringify(contactHold(core, threadId));
  const scope = storedScope(core, threadId) ?? {bindings: [], legacy: false, peers: []};
  scope.holders ??= scope.legacy ? [...scope.peers] : [];
  for (const letter of external) {
    if (!scope.peers.includes(letter.contact!.coreId)) scope.peers.push(letter.contact!.coreId);
    if (!letter.sharedProjectId) {
      scope.legacy = true;
      if (!scope.holders.includes(letter.contact!.coreId)) scope.holders.push(letter.contact!.coreId);
      continue;
    }
    // This validates the current association and canonical sender, even on a resumed inbox.
    const peer = core.contacts.peers().find(p => p.coreId === letter.from.coreId);
    if (!peer) throw refused('letter.from: expected the current contact route');
    incomingContact(core, letter, peer);
    const shared = core.sharedProjects.require(letter.sharedProjectId), {local, index} = core.sharedProjects.endpoints(shared);
    core.sharedProjects.assertActive(shared);
    if (!scope.bindings.some(b => b.job.sharedProjectId === shared.id)) scope.bindings.push({
      job: {id: null, sharedProjectId: shared.id, grantRevision: shared.access[index].revision, source: letter.from.sharedThread!},
      checkoutPath: realpathSync(thread.cwd), threadId,
      actor: letter.origin === 'contact-human' ? {kind: 'human', project: letter.from.sharedThread!.project} : {kind: 'agent', project: letter.from.sharedThread!.project, threadId: letter.from.sharedThread!.threadId, address: letter.from.sharedThread!.address, agent: 'shared agent'},
    });
    // Source identities never come from a thread-id alias.
    if (thread.projectId !== local.projectId) throw refused('letter.to: expected the captured project');
  }
  core.journal.setSetting(`shared-file-letters:${threadId}`, scope);
  core.sharedAccess.execution.reconcile();
  if (JSON.stringify(contactHold(core, threadId)) !== before) announceHold(core, [threadId]);
  core.sharedAccess.assertTurn(threadId);
}
