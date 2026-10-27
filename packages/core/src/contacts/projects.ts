/** Explicit bilateral project associations over the existing signed, sealed Contacts link. */
import { randomUUID } from 'node:crypto';
import { RpcErrorCode } from '@boite/contracts';
import type { AgentMatch, AgentTranscript, RpcParams, SharedComputePolicy, SharedProject, SharedProjectActor, SharedProjectPeerMethods, SharedProjectPeerRequest, SharedProjectRef, SharedProjectScope, SharedProjectThread, SharedProjectView } from '@boite/contracts';
import type { Core } from '../core.ts';
import type { Connection } from '../router.ts';
import { text } from '../coordination-letter.ts';
import { checkMatchExtras, checkRemoteContact, checkTranscript, searchContacts, searchWords, transcript } from '../coordination-lookup.ts';
import { PeerRefusal } from '../coordination-wire.ts';
import { invalidParams, refused, RpcFailure } from '../errors.ts';
import { SharedProjectJournal, fingerprint } from './project-journal.ts';
import { accessRecord, initialAccess, offeredProject, projectRef, sameProject, sourceActor, threadRef, projectAddress } from './project-policy.ts';
import { SharedProjectSubscriptions } from './project-subscriptions.ts';
import { projectContact, checkProjectRoute, projectRoute } from './project-relay.ts';
import { redactSharedText, redactSharedContact } from './file-policy.ts';

export interface SharedPeerContext {
  shared: SharedProject;
  local: SharedProjectRef;
  remote: SharedProjectRef;
  source: SharedProjectActor;
  peerId: string;
}
type PeerHandler<M extends keyof SharedProjectPeerMethods> = (params: SharedProjectPeerMethods[M]['params'], context: SharedPeerContext, requestId: string) => SharedProjectPeerMethods[M]['result'] | Promise<SharedProjectPeerMethods[M]['result']>;

export class SharedProjects {
  readonly journal: SharedProjectJournal;
  readonly subscriptions: SharedProjectSubscriptions;
  private readonly handlers = new Map<string, (params: never, ctx: SharedPeerContext, requestId: string) => unknown>();
  private readonly flushing = new Map<string, Promise<void>>();
  private readonly off: () => void;
  private closed = false;
  private readonly synchronizers = new Set<(peerId: string) => Promise<void>>();
  private readonly policyListeners = new Set<(id: string) => void>();
  configureCompute?: (params: RpcParams<'sharedProjects.configure'>, ctx: SharedPeerContext) => {policy: SharedComputePolicy; changed: boolean};

  constructor(readonly core: Core) {
    this.journal = new SharedProjectJournal(core.journal.db);
    this.subscriptions = new SharedProjectSubscriptions(this);
    this.off = core.bus.onCommitted((name, payload) => {
      if (this.closed) return;
      if (name === 'group.updated' || name === 'contacts.updated' || name === 'project.updated' || name === 'project.removed') this.reconcile();
      const threadId = name === 'thread.created' || name === 'thread.updated' ? (payload as { id: string }).id : (payload as { threadId?: string }).threadId;
      if (name === 'contacts.updated') {
        this.subscriptions.invalidateAll(); this.subscriptions.contactChanged();
        // Member mirrors have no direct ContactStore.tell loop. Reuse the same
        // durable flush on mirror/reconnect changes, rather than adding polling.
        for (const peer of core.contacts.peers().filter(p => core.contacts.isRelayPeer(p))) queueMicrotask(() => { if (!this.closed) void this.flush(peer.coreId).catch(() => undefined); });
      }
      if (threadId && (name.startsWith('thread.') || name === 'collaboration.changed' || name === 'turn.finished' || name === 'message.completed')) {
        this.subscriptions.sourceChanged(threadId);
        const projectId = core.journal.getThread(threadId)?.projectId;
        for (const shared of this.journal.all()) {
          if (this.endpoints(shared).local.projectId === projectId || name === 'thread.removed') this.notify(shared.id, ['threads']);
        }
      }
    });
    // A grant removed while this core was stopped remains removed at recovery.
    this.reconcile();
  }

  self(): string { return this.core.coordination.card().coreId; }
  endpoints(shared: SharedProject): { local: SharedProjectRef; remote: SharedProjectRef; index: 0 | 1 } {
    const index = shared.projects[0].coreId === this.self() ? 0 : 1;
    return { local: shared.projects[index], remote: shared.projects[index === 0 ? 1 : 0], index };
  }
  require(id: string): SharedProject {
    const shared = this.journal.get(text(id, 'sharedProjectId', 100));
    if (!shared) throw refused('sharedProjectId: expected an associated project of this core');
    return shared;
  }
  private save(shared: SharedProject): void {
    const { local, remote } = this.endpoints(shared);
    this.journal.put(shared, remote.ownerCoreId, local.projectId);
    if (this.journal.policy(shared.id) === null) this.journal.setPolicy(shared.id, this.policy(shared));
  }
  private policy(shared: SharedProject): string {
    const { local, remote } = this.endpoints(shared);
    const contact = projectContact(this.core, local, remote.ownerCoreId);
    const grant = contact?.grants.find(g => g.projectId === local.projectId && (!('machine' in g) || !g.machine || g.machine === local.coreId));
    return fingerprint({ contact: contact && 'addedAt' in contact ? contact.addedAt : local.ownerCoreId, grant });
  }
  private grant(local: SharedProjectRef, peerId: string, ownerProposal = false): boolean {
    const project = this.core.journal.getProject(local.projectId);
    return local.coreId === this.self() && !!project && !project.archived && (ownerProposal || !this.core.contacts.policyRevoked(peerId, local.projectId))
      && projectContact(this.core, local, peerId)?.grants.some(g => g.projectId === local.projectId && (!('machine' in g) || !g.machine || g.machine === local.coreId)) === true;
  }
  assertActive(shared: SharedProject): void {
    const { local, remote } = this.endpoints(shared);
    if (this.closed || shared.state !== 'active' || shared.access.some(a => a.revokedAt !== null) || !this.grant(local, remote.ownerCoreId)) throw refused('sharedProjectId: association or project grant is not active');
  }
  actor(threadId: string, project: SharedProjectRef, connection?: Connection): SharedProjectActor {
    const thread = this.core.threads.require(threadId);
    const config = this.core.coordination.config(threadId);
    if (thread.projectId !== project.projectId || thread.archived || config.mode === 'off' || !config.remote) throw refused('threadId: expected an unarchived source of the associated project with remote coordination enabled');
    if (connection?.identity.principal !== 'agent' && connection !== undefined) return { kind: 'human', project };
    this.core.contacts.checkSendTier(threadId);
    return { kind: 'agent', project, threadId, address: projectAddress(project, threadId), agent: this.core.coordination.describe(threadId).agent ?? '' };
  }
  scope(p: SharedProjectScope, connection?: Connection): SharedPeerContext {
    this.core.sharedCompute?.assertScope(p.threadId, p.sharedProjectId);
    this.core.sharedAccess?.assertScope(p.threadId, p.sharedProjectId);
    const shared = this.require(p.sharedProjectId);
    this.assertActive(shared);
    const { local, remote } = this.endpoints(shared);
    return { shared, local, remote, source: this.actor(p.threadId, local, connection), peerId: remote.ownerCoreId };
  }
  private view(shared: SharedProject): SharedProjectView {
    const { local, remote } = this.endpoints(shared);
    const contact = projectContact(this.core, local, remote.ownerCoreId);
    return { shared, local, remote, contact: { coreId: remote.ownerCoreId, name: contact?.name ?? 'Contact' },
      connection: contact && ('via' in contact ? contact.link : this.core.contacts.view(contact).link) === 'connected' ? 'connected' : sameProject(shared.authority, remote) ? 'authority-unavailable' : 'offline',
      protection: { defaultDeny: true, activeOverrides: this.core.sharedAccess?.activeOverrides(shared.id) ?? 0, reviewer: this.core.sharedReview?.status(shared.id) ?? 'off' } };
  }
  list(threadId: string, connection?: Connection): SharedProjectView[] {
    const thread = this.core.threads.require(threadId);
    if (!thread.projectId) return [];
    const bound = this.core.sharedAccess?.bound(threadId)?.job.sharedProjectId ?? this.core.sharedCompute?.associationFor(threadId);
    return this.journal.all(thread.projectId).filter(shared => !bound || shared.id === bound).map(shared => { this.actor(threadId, this.endpoints(shared).local, connection); return this.view(shared); });
  }
  get(p: SharedProjectScope, connection?: Connection): SharedProjectView {
    this.core.sharedCompute?.assertScope(p.threadId, p.sharedProjectId);
    this.core.sharedAccess?.assertScope(p.threadId, p.sharedProjectId);
    const shared = this.require(p.sharedProjectId);
    this.actor(p.threadId, this.endpoints(shared).local, connection);
    return this.view(shared);
  }
  hasContact(coreId: string): boolean { return this.journal.all(undefined, coreId).some(s => s.state === 'active' || s.state === 'revoked'); }
  forThread(threadId: string, peerId: string): SharedProject[] {
    const projectId = this.core.threads.require(threadId).projectId;
    const bound = this.core.sharedCompute?.associationFor(threadId);
    return projectId ? this.journal.all(projectId, peerId).filter(s => s.state === 'active' && (!bound || s.id === bound)) : [];
  }

  async offer(p: RpcParams<'sharedProjects.offer'>): Promise<SharedProjectView> {
    const peerId = text(p.coreId, 'coreId', 100);
    const owner = this.core.contacts.has(peerId) ? this.self() : this.core.contacts.members.relayedOf(peerId).find(e => e.grants.some(g => g.projectId === p.projectId))?.via;
    const local = projectRef({ ownerCoreId: owner, coreId: p.machine ?? this.self(), projectId: p.projectId });
    const remote = projectRef(p.remote, 'remote');
    if (local.coreId !== this.self()) throw refused('machine: offer from the project owning Store/core');
    if (remote.ownerCoreId !== peerId || !this.grant(local, peerId, true)) throw refused('projectId: expected a project explicitly granted to this contact');
    if (projectContact(this.core, local, peerId)?.capabilities?.sharedProjects !== 1) throw refused('coreId: contact must negotiate sharedProjects version 1 before association');
    const requestId = text(p.requestId, 'requestId', 100);
    const id = this.journal.transaction(() => this.journal.once(`owner:offer:${local.projectId}`, requestId, { method: 'offer', ...p }, () => {
      // A fresh owner proposal renews only this host's policy hold. Peer offers,
      // mirrored grants and old request receipts can never perform this action.
      this.core.contacts.restoreForOwner(peerId, local.projectId);
      const now = Date.now();
      const shared: SharedProject = { id: `shp_${randomUUID()}`, projects: [local, remote], authority: local, state: 'pending', access: [initialAccess(local), initialAccess(remote)], createdAt: now, updatedAt: now };
      this.save(shared);
      this.queue(shared, { method: 'offer', requestId, project: shared });
      return shared.id;
    }));
    await this.flush(peerId);
    this.notify(id);
    return this.view(this.require(id));
  }
  async decide(p: RpcParams<'sharedProjects.decide'>): Promise<SharedProjectView> {
    if (typeof p.accept !== 'boolean') throw invalidParams('accept: expected a boolean');
    const requestId = text(p.requestId, 'requestId', 100);
    const peerId = this.journal.transaction(() => this.journal.once(`owner:${p.sharedProjectId}`, requestId, { method: 'decide', ...p }, () => {
      const shared = this.require(p.sharedProjectId);
      const { local, remote, index } = this.endpoints(shared);
      if (index !== 1 || shared.state !== 'pending' || !this.grant(local, remote.ownerCoreId)) throw refused('sharedProjectId: expected an incoming pending association with a current project grant');
      shared.state = p.accept ? 'active' : 'declined';
      shared.updatedAt = Date.now();
      this.save(shared);
      this.queue(shared, { method: 'decide', requestId, sharedProjectId: shared.id, accept: p.accept });
      return remote.ownerCoreId;
    }));
    await this.flush(peerId);
    this.notify(p.sharedProjectId);
    return this.view(this.require(p.sharedProjectId));
  }
  async revoke(p: RpcParams<'sharedProjects.revoke'>): Promise<SharedProjectView> {
    const requestId = text(p.requestId, 'requestId', 100);
    const peerId = this.journal.transaction(() => this.journal.once(`owner:${p.sharedProjectId}`, requestId, { method: 'revoke', ...p }, () => {
      const shared = this.require(p.sharedProjectId);
      this.closeAssociation(shared);
      return this.endpoints(shared).remote.ownerCoreId;
    }));
    this.notify(p.sharedProjectId);
    await this.flush(peerId);
    return this.view(this.require(p.sharedProjectId));
  }
  async configure(p: RpcParams<'sharedProjects.configure'>): Promise<SharedProjectView> {
    if (p.board !== undefined && typeof p.board !== 'boolean') throw invalidParams('board: expected a boolean');
    // Host validation is installed by the compute/reviewer services, never inferred here.
    if (p.computeThreadId !== undefined && p.compute === undefined) throw invalidParams('computeThreadId: expected compute policy in the same host configuration');
    const result = this.core.bus.afterCommit(() => this.journal.transaction(() => {
      const shared = this.require(p.sharedProjectId);
      this.assertActive(shared);
      const {local, index, remote} = this.endpoints(shared);
      const compute = p.compute === undefined ? undefined : this.configureCompute?.(p, this.scopeForOwner(shared));
      if (p.compute !== undefined && compute === undefined) throw refused('configure: compute requires its host policy service');
      // Validate every host policy in the same transaction, including its private compute binding.
      if (p.reviewer !== undefined) this.core.sharedReview.configure(shared.id, p.reviewer);
      const changed = p.board !== undefined && p.board !== shared.access[index].board || !!compute?.changed;
      if (changed) {
        shared.access[index] = { ...shared.access[index], project: local, ...(p.board === undefined ? {} : { board: p.board }), ...(compute === undefined ? {} : { compute: compute.policy }), revision: shared.access[index].revision + 1 };
        shared.updatedAt = Date.now();
        this.save(shared);
        this.queueAccess(shared);
      }
      return {id: shared.id, peerId: remote.ownerCoreId, changed};
    }));
    if (result.changed || p.reviewer !== undefined) this.notify(result.id);
    if (result.changed) await this.flush(result.peerId);
    return this.view(this.require(result.id));
  }
  /** Host-only consequence. Called inside the same transaction as a locally confirmed review verdict. */
  revokeForPolicy(id: string): void {
    const shared = this.require(id), {local, remote} = this.endpoints(shared);
    this.closeAssociation(shared);
    // Removes this exact project grant and reply windows, rejects queued provider wakes,
    // and lets existing policy listeners fence board/compute. Unrelated grants stay intact.
    this.core.contacts.revokeForPolicy({coreId: remote.ownerCoreId, projectId: local.projectId});
    this.notify(id);
    this.core.bus.afterCommit(() => {void this.flush(remote.ownerCoreId).catch(() => undefined);});
  }
  private scopeForOwner(shared: SharedProject): SharedPeerContext {
    const {local, remote} = this.endpoints(shared);
    return {shared, local, remote, peerId: remote.ownerCoreId, source: {kind: 'human', project: local}};
  }
  private queue(shared: SharedProject, payload: SharedProjectPeerRequest): void {
    this.journal.enqueue(this.endpoints(shared).remote.ownerCoreId, shared.id, payload);
  }
  private queueAccess(shared: SharedProject): void {
    const { local, index } = this.endpoints(shared);
    this.queue(shared, { method: 'access', requestId: randomUUID(), sharedProjectId: shared.id, grantRevision: shared.access[index === 0 ? 1 : 0].revision, source: { kind: 'human', project: local }, params: { access: shared.access[index] } });
  }
  private closeAssociation(shared: SharedProject): void {
    if (shared.state === 'revoked') return;
    const { index, local } = this.endpoints(shared);
    shared.state = 'revoked';
    shared.updatedAt = Date.now();
    shared.access[index] = { ...shared.access[index], revokedAt: shared.updatedAt, revision: shared.access[index].revision + 1 };
    this.save(shared);
    this.queue(shared, { method: 'revoke', requestId: randomUUID(), sharedProjectId: shared.id, grantRevision: shared.access[index === 0 ? 1 : 0].revision, source: { kind: 'human', project: local }, params: {} });
  }
  private reconcile(): void {
    this.journal.transaction(() => {
      for (const shared of this.journal.all()) {
        const { local, remote, index } = this.endpoints(shared);
        if (shared.state !== 'revoked' && !this.grant(local, remote.ownerCoreId)) { this.closeAssociation(shared); this.notify(shared.id); }
        const hash = this.policy(shared);
        if (hash !== this.journal.policy(shared.id)) {
          this.journal.setPolicy(shared.id, hash);
          if (shared.state === 'active') {
            shared.access[index].revision += 1;
            shared.updatedAt = Date.now(); this.save(shared); this.queueAccess(shared); this.notify(shared.id);
          }
        }
      }
    });
  }
  async flush(peerId: string): Promise<void> {
    const running = this.flushing.get(peerId);
    if (running) return running;
    const job = (async () => {
      for (;;) {
        const entry = this.journal.queued(peerId)[0];
        if (!entry) break;
        if (this.closed) return;
        try { await this.exchange(peerId, entry.payload); }
        catch (error) {
          if (!(error instanceof PeerRefusal)) return;
          const id = entry.payload.method === 'offer' ? entry.payload.project.id : entry.payload.sharedProjectId;
          const shared = this.journal.get(id);
          if (shared && shared.state !== 'revoked' && (entry.payload.method === 'offer' || entry.payload.method === 'decide')) {
            shared.state = 'declined'; shared.updatedAt = Date.now(); this.save(shared); this.notify(id);
          }
        }
        this.journal.ack(entry.id);
      }
      for (const sync of this.synchronizers) if (!this.closed) await sync(peerId);
    })();
    this.flushing.set(peerId, job);
    try { await job; } finally { this.flushing.delete(peerId); }
  }
  private exchange(peerId: string, payload: SharedProjectPeerRequest): Promise<unknown> {
    const peer = this.core.contacts.peers().find(p => p.coreId === peerId);
    if (!peer || this.closed) throw refused('coreId: contact permission revoked');
    const shared = payload.method === 'offer' ? payload.project : this.require(payload.sharedProjectId);
    const {local, remote} = this.endpoints(shared);
    return this.core.coordination.request(peer, 'contact.project', {...payload, route: {source: local, target: remote}});
  }
  async request<M extends keyof SharedProjectPeerMethods>(ctx: SharedPeerContext, method: M, params: SharedProjectPeerMethods[M]['params'], requestId: string = randomUUID()): Promise<SharedProjectPeerMethods[M]['result']> {
    const { shared, source } = ctx;
    this.assertActive(this.require(shared.id));
    const { index } = this.endpoints(shared);
    const revision = shared.access[index].revision;
    let result: unknown;
    try { result = await this.exchange(ctx.peerId, { method, params, requestId, sharedProjectId: shared.id, grantRevision: shared.access[index === 0 ? 1 : 0].revision, source } as SharedProjectPeerRequest); }
    catch (error) { if (error instanceof PeerRefusal) throw refused(error.message); throw error; }
    const current = this.require(shared.id);
    this.assertActive(current);
    if (current.access[index].revision !== revision || current.access[index === 0 ? 1 : 0].revision !== shared.access[index === 0 ? 1 : 0].revision) throw refused('sharedProjectId: grant changed during request');
    if (source.kind === 'agent') this.actor(source.threadId, source.project);
    return result as SharedProjectPeerMethods[M]['result'];
  }

  registerPeer<M extends keyof SharedProjectPeerMethods>(method: M, handler: PeerHandler<M>): void { this.handlers.set(method, handler as never); }
  /** Reuse Contacts reconnect/retry scheduling; extensions do not start polling timers. */
  registerFlush(sync: (peerId: string) => Promise<void>): void { this.synchronizers.add(sync); }
  registerPolicyListener(listener: (id: string) => void): void { this.policyListeners.add(listener); }
  /** Recheck after a delegated async handler before returning data or acknowledging a write. */
  assertPeer(ctx: SharedPeerContext): void {
    const current = this.require(ctx.shared.id);
    this.assertActive(current);
    if (current.access.some((a, i) => a.revision !== ctx.shared.access[i]!.revision)) throw refused('sharedProjectId: grant changed during request');
    if (ctx.source.kind === 'agent') this.core.contacts.checkAttestedTier(ctx.source.agent);
  }
  async receive(peerId: string, value: unknown): Promise<unknown> {
    if (!this.core.contacts.isContact(peerId)) throw refused('coreId: expected a contact');
    const p = value as SharedProjectPeerRequest;
    if (!p || typeof p.method !== 'string') throw invalidParams('contact.project: expected a method');
    const requestId = text(p.requestId, 'requestId', 100);
    if (p.method === 'offer') return this.journal.transaction(() => this.journal.once(`peer:${peerId}:${text(p.project?.id, 'offer.id', 100)}`, requestId, p, () => {
      const shared = offeredProject(p.project, peerId, this.self(), projectRoute(p)?.target.ownerCoreId);
      const { local } = this.endpoints(shared);
      if (!this.grant(local, peerId)) throw refused('offer.project: local project is not granted to this contact');
      if (this.journal.get(shared.id)) throw refused('offer.id: association already exists');
      this.save(shared);
      this.notify(shared.id);
      return { ok: true };
    }));
    const shared = this.require(p.sharedProjectId);
    const { local, remote, index } = this.endpoints(shared);
    checkProjectRoute(p, local, remote);
    if (remote.ownerCoreId !== peerId) throw refused('sharedProjectId: not associated with this contact');
    if (p.method === 'decide') return this.journal.transaction(() => this.journal.once(`peer:${peerId}:${shared.id}`, requestId, p, () => {
      if (index !== 0 || shared.state !== 'pending' || typeof p.accept !== 'boolean' || !this.grant(local, peerId)) throw refused('decide: expected a pending outgoing association and current project grant');
      shared.state = p.accept ? 'active' : 'declined';
      shared.updatedAt = Date.now(); this.save(shared); this.notify(shared.id);
      return { ok: true };
    }));
    const source = sourceActor(p.source, remote);
    if (source.kind === 'agent') this.core.contacts.checkAttestedTier(source.agent);
    if (p.method === 'revoke') return this.journal.transaction(() => this.journal.once(`peer:${peerId}:${shared.id}`, requestId, p, () => {
      if (source.kind !== 'human') throw refused('revoke: only the endpoint owner closes its consent');
      if (shared.state !== 'revoked') { shared.state = 'revoked'; shared.updatedAt = Date.now(); shared.access[index === 0 ? 1 : 0].revokedAt = shared.updatedAt; this.save(shared); this.notify(shared.id); }
      return { ok: true };
    }));
    this.assertActive(shared);
    if (p.method === 'access') return this.journal.transaction(() => this.journal.once(`peer:${peerId}:${shared.id}`, requestId, p, () => {
      if (source.kind !== 'human') throw refused('access: only the endpoint owner changes its consent');
      const next = accessRecord(p.params?.access, remote);
      const previous = shared.access[index === 0 ? 1 : 0];
      if (next.revision === previous.revision && fingerprint(next) !== fingerprint(previous)) throw refused('access.revision: different content at an existing revision');
      if (next.revision > previous.revision) { shared.access[index === 0 ? 1 : 0] = next; if (next.revokedAt !== null) shared.state = 'revoked'; shared.updatedAt = Date.now(); this.save(shared); this.notify(shared.id); }
      return { ok: true };
    }));
    if (p.grantRevision !== shared.access[index].revision) throw refused('grantRevision: expected the current destination grant revision');
    const ctx: SharedPeerContext = { shared, local, remote, source, peerId };
    const action = p.method.startsWith('compute.') ? 'compute' : p.method.startsWith('board.') ? 'board' : p.method === 'threads' ? 'directory' : 'read';
    try {
    let result: unknown;
    if (p.method === 'view') result = shared;
    else if (p.method === 'threads') result = this.localThreads(ctx);
    else if (p.method === 'search') result = this.localSearch(ctx, p.params?.query);
    else if (p.method === 'read') result = this.localRead(ctx, p.params);
    else if (p.method === 'subscribe') result = this.subscriptions.receiveSubscribe(ctx, p.params);
    else if (p.method === 'changed') result = await this.subscriptions.receiveChanged(ctx, p.params);
    else {
      const handler = this.handlers.get(p.method);
      if (!handler) throw refused(`contact.project.method: ${p.method} is not supported`);
      result = await handler(p.params as never, ctx, requestId);
    }
    this.assertPeer(ctx);
    if (!['changed', 'subscribe', 'board.changed', 'view'].includes(p.method)) this.core.sharedAccess.record(ctx, action, 'allowed', 'scoped-request');
    return result;
    } catch (error) {
      this.core.sharedAccess.record(ctx, action, 'denied', 'request-denied');
      throw error;
    }
  }

  localThreads(ctx: SharedPeerContext): SharedProjectThread[] {
    this.assertActive(this.require(ctx.shared.id));
    return this.core.journal.listThreads(ctx.local.projectId).filter(t => !t.archived && this.core.coordination.config(t.id).mode !== 'off' && this.core.coordination.config(t.id).remote)
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100).map(t => {
        const ref = { project: ctx.local, threadId: t.id, address: projectAddress(ctx.local, t.id) };
        const agent = { ...redactSharedContact(this.core.coordination.describe(t.id)), ...ref.address, sharedThread: ref };
        return { ref, agent, machine: agent.machine, readThreads: sameProject(ctx.source.project, ctx.local) || this.core.contacts.mayRead(ctx.peerId, t.id) };
      });
  }
  private remoteThreads(ctx: SharedPeerContext, value: unknown): SharedProjectThread[] {
    if (!Array.isArray(value) || value.length > 100) throw invalidParams('threads: expected up to 100 descriptors');
    const peer = this.core.contacts.peers().find(p => p.coreId === ctx.peerId)!;
    return value.map(row => {
      const ref = threadRef(row?.ref);
      if (!sameProject(ref.project, ctx.remote) || typeof row.readThreads !== 'boolean') throw refused('threads.ref.project: expected the exact associated endpoint');
      const agent = checkRemoteContact(row.agent, peer);
      if (agent.threadId !== ref.address.threadId) throw refused('threads.ref.threadId: expected descriptor address');
      return { ref, agent: { ...agent, sharedThread: ref }, machine: text(row.machine, 'threads.machine', 100), readThreads: row.readThreads };
    });
  }
  async threads(p: SharedProjectScope, connection?: Connection): Promise<{ threads: SharedProjectThread[]; unavailable: SharedProjectRef[] }> {
    const ctx = this.scope(p, connection);
    let remote: SharedProjectThread[] = [];
    const unavailable: SharedProjectRef[] = [];
    try { remote = this.remoteThreads(ctx, await this.request(ctx, 'threads', {})); }
    catch (error) { if (error instanceof RpcFailure && error.code !== RpcErrorCode.Unavailable) throw error; unavailable.push(ctx.remote); }
    const current = this.scope(p, connection);
    return { threads: [...this.localThreads(current), ...remote], unavailable };
  }
  private localSearch(ctx: SharedPeerContext, query: unknown): AgentMatch[] {
    const entries = this.localThreads(ctx);
    const words = searchWords(query);
    return [true, false].flatMap(read => searchContacts(this.core.journal.db, entries.filter(t => t.readThreads === read).map(t => ({...t.agent, threadId: t.ref.threadId})), words, read, redactSharedText)).map(match => {
      const ref = entries.find(t => t.ref.threadId === match.threadId)!.ref;
      return {...match, ...ref.address, sharedThread: ref};
    });
  }
  async search(p: SharedProjectScope & { query: string }, connection?: Connection): Promise<{ matches: AgentMatch[]; unavailable: SharedProjectRef[] }> {
    const ctx = this.scope(p, connection);
    searchWords(p.query);
    let remote: AgentMatch[] = [];
    const unavailable: SharedProjectRef[] = [];
    try {
      const raw = await this.request(ctx, 'search', { query: p.query });
      if (!Array.isArray(raw) || raw.length > 100) throw invalidParams('matches: expected up to 100 scoped matches');
      remote = raw.map(row => {
        const ref = threadRef(row.sharedThread);
        if (!sameProject(ref.project, ctx.remote)) throw refused('matches.project: expected the associated endpoint');
        const peer = this.core.contacts.peers().find(p => p.coreId === ctx.peerId)!;
        const agent = checkRemoteContact(row, peer);
        if (agent.threadId !== ref.address.threadId) throw refused('matches.threadId: expected the scoped thread');
        return { ...agent, ...checkMatchExtras(row), sharedThread: ref };
      });
    } catch (error) { if (error instanceof RpcFailure && error.code !== RpcErrorCode.Unavailable) throw error; unavailable.push(ctx.remote); }
    const current = this.scope(p, connection);
    return { matches: [...this.localSearch(current, p.query), ...remote], unavailable };
  }
  private localRead(ctx: SharedPeerContext, p: SharedProjectPeerMethods['read']['params']): AgentTranscript {
    const target = threadRef(p?.target);
    if (!sameProject(target.project, ctx.local)) throw refused('target.project: expected the associated destination endpoint');
    const entry = this.localThreads(ctx).find(t => t.ref.threadId === target.threadId);
    if (!entry) throw refused('target.threadId: expected an available thread of this shared project');
    if (!entry.readThreads) throw refused('target.threadId: destination project requires readThreads');
    const limit = p.limit ?? 30;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalidParams('limit: expected 1 to 100');
    if (p.before !== undefined && !Number.isSafeInteger(p.before)) throw invalidParams('before: expected a timestamp');
    return { contact: entry.agent, ...transcript(this.core.journal.db, target.threadId, limit, p.before, id => this.core.journal.streamingMessage(id), redactSharedText) };
  }
  async read(p: RpcParams<'sharedProjects.read'>, connection?: Connection): Promise<AgentTranscript> {
    const ctx = this.scope(p, connection);
    const target = threadRef(p.target);
    if (sameProject(target.project, ctx.local)) return this.localRead(ctx, p);
    if (!sameProject(target.project, ctx.remote)) throw refused('target.project: expected one of the two associated endpoints');
    const raw = await this.request(ctx, 'read', { target, ...(p.limit === undefined ? {} : { limit: p.limit }), ...(p.before === undefined ? {} : { before: p.before }) });
    // A read buffered by the network cannot outlive a destination readThreads change.
    await this.request(ctx, 'view', {});
    this.scope(p, connection);
    const peer = this.core.contacts.peers().find(p => p.coreId === ctx.peerId)!;
    const contact = checkRemoteContact(raw?.contact, peer);
    if (contact.threadId !== target.address.threadId) throw refused('transcript.contact: expected the requested thread');
    return { contact: { ...contact, sharedThread: target }, ...checkTranscript(raw) };
  }
  notify(id: string, kinds: ('threads' | 'board' | 'compute' | 'access')[] = ['threads', 'board', 'compute', 'access']): void {
    if (kinds.includes('access')) for (const listener of this.policyListeners) listener(id);
    this.subscriptions.changed(id, kinds);
  }
  beginClose(): void { this.closed = true; this.off(); this.subscriptions.close(); }
  async close(): Promise<void> { this.beginClose(); await Promise.allSettled([...this.flushing.values(), this.subscriptions.settled()]); }
}

export function registerSharedProjectMethods(core: Core): void {
  const service = core.sharedProjects;
  core.router.register('sharedProjects.list', (p, c) => service.list(p.threadId, c.connection));
  core.router.register('sharedProjects.get', (p, c) => service.get(p, c.connection));
  core.router.register('sharedProjects.offer', p => service.offer(p));
  core.router.register('sharedProjects.decide', p => service.decide(p));
  core.router.register('sharedProjects.revoke', p => service.revoke(p));
  core.router.register('sharedProjects.configure', p => service.configure(p));
  core.router.register('sharedProjects.threads', (p, c) => service.threads(p, c.connection));
  core.router.register('sharedProjects.search', (p, c) => service.search(p, c.connection));
  core.router.register('sharedProjects.read', (p, c) => service.read(p, c.connection));
  core.router.register('sharedProjects.subscribe', (p, c) => service.subscriptions.subscribe(p, c.connection));
}
