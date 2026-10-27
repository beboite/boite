/** Durable replicas of the existing Todo/goal board. Its original project owner arbitrates claims. */
import type { RpcParams, SharedBoardCard, SharedBoardCommand, SharedBoardPage, SharedBoardReceipt, SharedProject, SharedProjectPeerMethods, SharedThreadRef, Todo } from '@boite/contracts';
import { RpcErrorCode } from '@boite/contracts';
import type { Core } from '../core.ts';
import type { Connection } from '../router.ts';
import { refused, invalidParams, RpcFailure } from '../errors.ts';
import { PeerRefusal } from '../coordination-wire.ts';
import { text } from '../coordination-letter.ts';
import { goalOf, notifySharedTodos } from '../todos.ts';
import { newId } from '../ids.ts';
import { SharedBoardJournal, type PendingBoardCommand, type BoardProgress } from './board-journal.ts';
import { boardCard, boardCommand, boardDelta, boardGoal, boardWorkerInfo, integer } from './board-policy.ts';
import { applyAtAuthority, progressAtAuthority, receipt } from './board-authority.ts';
import { projectAddress, sameProject, threadRef } from './project-policy.ts';
import { fingerprint } from './project-journal.ts';
import type { SharedPeerContext } from './projects.ts';
import { accessBinding, bindBoard } from './access-scopes.ts';

export class SharedBoard {
  readonly journal: SharedBoardJournal;
  private readonly flushing = new Map<string, Promise<void>>();
  private readonly flushAgain = new Set<string>();
  private readonly pulling = new Map<string, Promise<void>>();
  private readonly pullTargets = new Map<string, number>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly needsPull = new Set<string>();
  private readonly links = new Map<string, boolean>();
  private readonly stopping = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly off: () => void;
  /** File protection installs a host-enforced admission gate. Only the no-tools echo route works by default. */
  guardStart: (ctx: SharedPeerContext, worker: SharedThreadRef) => void | Promise<void> = async (_ctx, worker) => {
    const thread = this.core.threads.require(worker.threadId);
    if (!this.core.sharedAccess.execution.support(this.core.providers.require(thread.providerId).protocol, thread.providerId, thread.permissionMode).supported) throw refused('sharedBoard.start: this host must install shared execution file protection for this provider');
    if (!['queued', 'running', 'waiting'].includes(thread.status)) {
      this.core.threads.releaseAgent(thread.id);
      await this.core.procs.stopAndWait(thread.id);
    }
  };

  constructor(readonly core: Core) {
    this.journal = new SharedBoardJournal(core.journal.db);
    for (const shared of core.sharedProjects.journal.all()) if (!this.authority(shared)) this.needsPull.add(shared.id);
    core.sharedProjects.registerPeer('board.get', (p, ctx) => { this.check(ctx, true); return this.journal.delta(ctx.shared.id, this.cursor(p?.after, ctx.shared.id)); });
    core.sharedProjects.registerPeer('board.apply', (p, ctx, requestId) => {
      const command = boardCommand(p?.command);
      if (command.requestId !== requestId) throw invalidParams('command.requestId: expected the envelope operation id');
      return this.authoritativeApply(ctx, command, boardWorkerInfo(p.workerInfo));
    });
    core.sharedProjects.registerPeer('board.progress', (p, ctx) => progressAtAuthority(this, ctx, this.progress(p)));
    core.sharedProjects.registerPeer('board.stop', async (p, ctx) => { await this.stopClaim(ctx, p); return {stopped: true}; });
    core.sharedProjects.registerPeer('board.changed', async (p, ctx) => {
      this.check(ctx);
      if (!sameProject(ctx.shared.authority, ctx.remote) || ctx.source.kind !== 'human') throw refused('board.changed: expected the immutable authority');
      const revision = integer(p?.revision, 'board.changed.revision');
      if (revision > this.journal.revision(ctx.shared.id)) await this.pull(this.ownerContext(ctx.shared), revision);
      return { ok: true };
    });
    core.sharedProjects.registerFlush(peerId => this.flush(peerId));
    core.sharedProjects.registerPolicyListener(id => this.reconcileAccess(id));
    this.off = core.bus.onCommitted((name, payload) => {
      if (this.closed) return;
      if (name === 'thread.activity' || name === 'thread.updated' || name === 'thread.removed') this.follow((payload as {threadId?: string; id?: string}).threadId ?? (payload as {id: string}).id);
      if (name === 'contacts.updated' || name === 'group.updated' || name === 'project.updated' || name === 'project.removed') {
        for (const contact of core.contacts.peers()) {
          const linked = core.contacts.linkOf(contact.coreId) === 'connected', before = this.links.get(contact.coreId) ?? false;
          this.links.set(contact.coreId, linked);
          if (linked && !before) for (const shared of core.sharedProjects.journal.all(undefined, contact.coreId)) if (!this.authority(shared)) this.needsPull.add(shared.id);
        }
        this.schedule();
      }
    });
    // ActivityStore has already paused interrupted goals. Persist that new projection
    // before reconnect can acknowledge the old, running state again.
    const restored = new Set<string>();
    for (const shared of core.sharedProjects.journal.all()) for (const entry of this.journal.entries(shared.id)) {
      if (entry.kind === 'card' && entry.card.assignment && sameProject(entry.card.assignment.worker.project, core.sharedProjects.endpoints(shared).local)
        && (entry.card.assignment.state !== 'reserved' || core.activity.get(entry.card.assignment.worker.threadId).goal)) restored.add(entry.card.assignment.worker.threadId);
    }
    for (const threadId of restored) this.follow(threadId);
  }
  private background(work: Promise<unknown>): void { this.pending.add(work); void work.catch(() => undefined).finally(() => this.pending.delete(work)); }
  /** Permanent association revocation closes only core-tagged shared goals and their captured descendants. */
  reconcileAccess(id: string): void {
    if (this.closed) return;
    const shared = this.core.sharedProjects.require(id);
    if (shared.state === 'active' && shared.access.every(a => a.board && a.revokedAt === null)) return;
    for (const value of this.journal.pending(id)) this.journal.settle(id, value, {requestId: value.command.requestId, outcome: 'revoked', revision: this.journal.revision(id), card: null});
    const local = this.core.sharedProjects.endpoints(shared).local;
    for (const entry of this.journal.entries(id)) {
      if (entry.kind !== 'card' || !entry.card.assignment || !sameProject(entry.card.assignment.worker.project, local)) continue;
      const {claimId, worker} = entry.card.assignment;
      const key = this.stopKey(id, entry.card.id, claimId);
      if (!this.core.journal.getSetting(key)) this.core.journal.setSetting(key, {hash: fingerprint({cardId: entry.card.id, claimId, worker}), state: 'revoked'});
      const binding = this.core.journal.getSetting(`activity:shared:${worker.threadId}`) as {sharedProjectId?: string; claimId?: string} | null;
      const captured = new Set<string>();
      // Capture descendants before removing the parent's tag. Their file-policy scopes remain durable.
      for (const child of this.core.journal.listChildThreads()) {
        const scope = accessBinding(this.core, child.id);
        if (scope?.job.sharedProjectId === id && scope.board?.threadId === worker.threadId && scope.board.claimId === claimId) captured.add(child.id);
      }
      if (binding?.sharedProjectId === id && binding.claimId === claimId) {
        const activity = this.core.activity.get(worker.threadId);
        if (activity.goal && !activity.loop) {
          captured.add(worker.threadId);
          this.core.activity.control({threadId: worker.threadId, kind: 'goal', action: 'remove'});
        }
      }
      for (const threadId of captured) {
        this.core.threads.stopTurn(threadId); this.core.threads.releaseAgent(threadId);
        this.background(Promise.allSettled([this.core.scheduler.stopAndWait(threadId), this.core.procs.stopAndWait(threadId)]));
      }
    }
    notifySharedTodos(this.core, local.projectId);
  }
  private authority(shared: SharedProject): boolean { return sameProject(shared.authority, this.core.sharedProjects.endpoints(shared).local); }
  check(ctx: SharedPeerContext, authority = false): void {
    this.core.sharedProjects.assertPeer(ctx);
    if (!this.core.sharedProjects.require(ctx.shared.id).access.every(a => a.board)) throw refused('sharedBoard: both project owners must enable board access');
    if (authority && !this.authority(ctx.shared)) throw refused('sharedBoard: only the immutable project authority applies operations');
  }
  private ownerContext(shared: SharedProject): SharedPeerContext {
    const {local, remote} = this.core.sharedProjects.endpoints(shared);
    return {shared, local, remote, peerId: remote.ownerCoreId, source: {kind: 'human', project: local}};
  }
  private queuedContext(shared: SharedProject, value: PendingBoardCommand): SharedPeerContext {
    const ctx = this.ownerContext(shared);
    this.check(ctx);
    // Revalidate the persisted source, including its project's current communication setting.
    const actor = this.core.sharedProjects.actor(value.threadId, ctx.local, value.source.kind === 'human' ? {identity: {principal: 'owner'}} as Connection : undefined);
    return {...ctx, source: actor};
  }
  private cursor(after: unknown, id: string): number {
    const value = after === undefined ? 0 : integer(after, 'after');
    if (value > this.journal.revision(id)) throw invalidParams('after: expected a revision at or below the board head');
    return value;
  }
  changed(id: string): void {
    this.core.sharedProjects.notify(id, ['board']);
    notifySharedTodos(this.core, this.core.sharedProjects.endpoints(this.core.sharedProjects.require(id)).local.projectId);
    this.schedule();
  }
  private schedule(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const contact of this.core.contacts.peers()) if (this.core.contacts.linkOf(contact.coreId) === 'connected') this.background(this.flush(contact.coreId));
    }, 50);
    this.timer.unref?.();
  }
  async get(p: RpcParams<'sharedBoard.get'>, connection?: Connection): Promise<SharedBoardPage> {
    let ctx = this.core.sharedProjects.scope(p, connection); this.check(ctx);
    let available = true;
    if (!this.authority(ctx.shared)) {
      try { await this.flushAssociation(ctx.shared.id); await this.pull(ctx); }
      catch (error) { if (!this.offline(error)) throw error; available = false; }
    }
    ctx = this.core.sharedProjects.scope(p, connection); this.check(ctx);
    if (p.after !== undefined) return {...this.journal.delta(ctx.shared.id, this.cursor(p.after, ctx.shared.id)), authorityAvailable: available};
    const page = this.journal.snapshot(ctx.shared.id);
    page.cards = this.optimistic(ctx.shared.id, page.cards);
    return {...page, authorityAvailable: available};
  }
  private optimistic(id: string, cards: SharedBoardCard[]): SharedBoardCard[] {
    const projected = new Map(cards.map(card => [card.id, card]));
    for (const {command: c, source} of this.journal.pending(id)) {
      const old = projected.get(c.cardId);
      if (this.journal.entry(id, c.cardId)?.kind === 'deleted') continue;
      if (c.kind === 'remove') projected.delete(c.cardId);
      else if (c.kind === 'add' && !old) projected.set(c.cardId, {id: c.cardId, text: c.text, status: 'open', revision: 0, createdBy: source, assignment: null, goal: null, createdAt: 0, updatedAt: 0, pending: true});
      else if (c.kind === 'update' && old) projected.set(c.cardId, {...old, ...(c.text === undefined ? {} : {text: c.text}), ...(c.status === undefined ? {} : {status: c.status}), pending: true});
    }
    return [...projected.values()];
  }
  async apply(p: RpcParams<'sharedBoard.apply'>, connection?: Connection): Promise<SharedBoardReceipt> {
    const ctx = this.core.sharedProjects.scope(p, connection); this.check(ctx);
    const command = boardCommand(p.command), value: PendingBoardCommand = {threadId: p.threadId, source: ctx.source, command};
    if (ctx.source.kind === 'agent' && (command.kind === 'remove' || command.kind === 'update' && command.status === 'done')) throw refused('sharedBoard: only the user confirms or removes a card');
    if (command.kind === 'claim') this.localWorker(ctx, command.worker);
    this.journal.enqueue(ctx.shared.id, value);
    const settled = this.journal.result(ctx.shared.id, value);
    if (settled) return settled;
    if (this.authority(ctx.shared)) {
      try {
        const result = await this.authoritativeApply(ctx, command, command.kind === 'claim' ? this.workerInfo(command.worker) : undefined);
        this.journal.settle(ctx.shared.id, value, result);
        return result;
      } catch (error) {
        this.journal.settle(ctx.shared.id, value, {requestId: command.requestId, outcome: 'revoked', revision: this.journal.revision(ctx.shared.id), card: null});
        throw error;
      }
    }
    const work = this.flushAssociation(ctx.shared.id);
    // The edit is durable before any network wait. A slow authority leaves an explicit queued receipt.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try { await (command.kind === 'claim' ? work : Promise.race([work, new Promise<void>(resolve => { timeout = setTimeout(resolve, 100); })])); }
    catch (error) { if (!this.offline(error)) throw error; }
    finally { if (timeout) clearTimeout(timeout); }
    this.background(work);
    this.core.sharedProjects.scope(p, connection); this.check(ctx);
    const result = this.journal.result(ctx.shared.id, value);
    if (result) return result;
    this.core.sharedProjects.notify(ctx.shared.id, ['board']);
    notifySharedTodos(this.core, ctx.local.projectId);
    const card = this.optimistic(ctx.shared.id, this.journal.snapshot(ctx.shared.id).cards).find(c => c.id === command.cardId) ?? null;
    return {requestId: command.requestId, outcome: 'queued', revision: this.journal.revision(ctx.shared.id), card};
  }
  private offline(error: unknown): boolean { return !(error instanceof PeerRefusal) && (!(error instanceof RpcFailure) || error.code === RpcErrorCode.Unavailable); }
  private async pull(ctx: SharedPeerContext, minimum = 0): Promise<void> {
    const id = ctx.shared.id;
    this.pullTargets.set(id, Math.max(minimum, this.pullTargets.get(id) ?? 0));
    const existing = this.pulling.get(id);
    if (existing) return existing;
    // Install the shared promise before admission can throw; clear it before callers resume.
    const work = Promise.resolve().then(async () => {
      try {
        let more = true;
        while (more && !this.closed) {
          this.check(ctx);
          const after = this.journal.revision(id), target = this.pullTargets.get(id) ?? 0;
          const page = boardDelta(await this.core.sharedProjects.request(ctx, 'board.get', {after}), ctx.shared);
          this.check(ctx);
          if (page.from !== after) throw invalidParams('board.from: expected the requested cursor');
          this.core.sharedProjects.journal.transaction(() => {
            for (const change of page.changes) if (change.revision > this.journal.revision(id)) this.journal.append(id, change);
          });
          if (page.changes.length) {
            this.core.sharedProjects.notify(id, ['board']);
            notifySharedTodos(this.core, ctx.local.projectId);
          }
          if (!page.changes.length && after < target) throw invalidParams('board.changed.revision: authority did not provide its announced revision');
          more = page.more || this.journal.revision(id) < (this.pullTargets.get(id) ?? 0);
        }
      } finally { this.pulling.delete(id); this.pullTargets.delete(id); }
    });
    this.pulling.set(id, work);
    return work;
  }
  async flush(peerId: string): Promise<void> {
    for (const shared of this.core.sharedProjects.journal.all(undefined, peerId)) {
      try { await this.flushAssociation(shared.id); } catch { /* Durable queues retry on the existing Contacts reconnect/flush. */ }
    }
  }
  private async flushAssociation(id: string): Promise<void> {
    const existing = this.flushing.get(id);
    if (existing) { this.flushAgain.add(id); return existing; }
    const work = (async () => {
      try {
        do { this.flushAgain.delete(id); await this.send(id); }
        while (!this.closed && this.flushAgain.has(id));
      } finally { this.flushing.delete(id); this.flushAgain.delete(id); }
    })();
    this.flushing.set(id, work);
    return work;
  }
  private async send(id: string): Promise<void> {
    if (this.closed) return;
    const shared = this.core.sharedProjects.require(id), ctx = this.ownerContext(shared);
    let sent = false;
    try { this.check(ctx); }
    catch {
      for (const value of this.journal.pending(id)) this.journal.settle(id, value, {requestId: value.command.requestId, outcome: 'revoked', revision: this.journal.revision(id), card: null});
      return;
    }
    for (const value of this.journal.pending(id)) {
      let source: SharedPeerContext;
      try { source = this.queuedContext(shared, value); }
      catch { this.journal.settle(id, value, {requestId: value.command.requestId, outcome: 'revoked', revision: this.journal.revision(id), card: null}); continue; }
      let result: SharedBoardReceipt;
      const workerInfo = value.command.kind === 'claim' ? this.workerInfo(value.command.worker) : undefined;
      try { result = this.authority(shared) ? await this.authoritativeApply(source, value.command, workerInfo) : await this.core.sharedProjects.request(source, 'board.apply', {command: value.command, ...(workerInfo ? {workerInfo} : {})}, value.command.requestId); }
      catch (error) {
        if (this.offline(error)) throw error;
        this.journal.settle(id, value, {requestId: value.command.requestId, outcome: 'revoked', revision: this.journal.revision(id), card: null});
        continue;
      }
      this.check(source);
      if (!result || result.requestId !== value.command.requestId || !['applied', 'conflict', 'deleted', 'revoked'].includes(result.outcome)) throw invalidParams('board.receipt: expected an authoritative terminal receipt');
      result = {requestId: result.requestId, outcome: result.outcome, revision: integer(result.revision, 'board.receipt.revision'), card: result.card === null ? null : boardCard(result.card, shared)};
      if (result.card && result.card.id !== value.command.cardId) throw invalidParams('board.receipt.card.id: expected the requested card');
      this.journal.settle(id, value, result);
      sent = true;
    }
    for (const p of this.journal.pendingProgress(id)) {
      const result = this.authority(shared) ? progressAtAuthority(this, ctx, p) : await this.core.sharedProjects.request(ctx, 'board.progress', p, fingerprint({card: p.cardId, claim: p.claimId, sequence: p.sequence}));
      if (result.outcome !== 'queued') this.journal.ackProgress(id, p);
    }
    if (this.authority(shared)) {
      const revision = this.journal.revision(id);
      if (revision > this.journal.notified(id)) {
        await this.core.sharedProjects.request(ctx, 'board.changed', {revision});
        this.journal.notify(id, revision);
      }
    } else if (sent || this.needsPull.has(id)) {
      await this.pull(ctx);
      this.needsPull.delete(id);
    }
  }
  private localWorker(ctx: SharedPeerContext, worker: SharedThreadRef, reviewedStart = false): void {
    if (!sameProject(worker.project, ctx.local) || ctx.source.kind === 'agent' && ctx.source.threadId !== worker.threadId) throw refused('worker: expected this host and the authenticated worker thread');
    const thread = this.core.threads.require(worker.threadId);
    if (thread.projectId !== ctx.local.projectId || thread.archived) throw refused('worker: expected an unarchived thread of this project');
    if (reviewedStart && thread.parentThreadId) throw refused('worker: a reviewed goal starts in a top-level thread');
  }
  private workerInfo(worker: SharedThreadRef): {agent: string; machine: string} {
    const agent = this.core.coordination.describe(worker.threadId);
    return {agent: agent.agent ?? 'Agent', machine: agent.machine};
  }
  private stopKey(id: string, cardId: string, claimId: string): string { return `shared-board-stop:${fingerprint([id, cardId, claimId])}`; }
  private async authoritativeApply(ctx: SharedPeerContext, command: SharedBoardCommand, workerInfo?: {agent: string; machine: string}): Promise<SharedBoardReceipt> {
    this.check(ctx, true);
    let stoppedClaim: string | undefined;
    if (command.kind === 'release') {
      const entry = this.journal.entry(ctx.shared.id, command.cardId);
      const assignment = entry?.kind === 'card' ? entry.card.assignment : null;
      if (assignment?.claimId === command.claimId) {
        if (ctx.source.kind === 'agent' && this.journal.actor(assignment.actor) !== this.journal.actor(ctx.source)) throw refused('claimId: only the claimant agent or a user releases a reservation');
        const p = {cardId: command.cardId, claimId: command.claimId, worker: assignment.worker};
        const owner = this.ownerContext(ctx.shared);
        if (sameProject(assignment.worker.project, ctx.local)) await this.stopClaim(owner, p);
        else {
          const result = await this.core.sharedProjects.request(owner, 'board.stop', p);
          if (result?.stopped !== true) throw refused('claimId: assigned host has not confirmed its execution stopped');
        }
        stoppedClaim = command.claimId;
      }
    }
    return applyAtAuthority(this, ctx, command, workerInfo, stoppedClaim);
  }
  /** Host proof precedes release. Unknown/unreachable work remains assigned, with no lease expiry. */
  private async stopClaim(ctx: SharedPeerContext, raw: SharedProjectPeerMethods['board.stop']['params']): Promise<void> {
    this.check(ctx);
    if (ctx.source.kind !== 'human' || !sameProject(ctx.source.project, ctx.shared.authority)) throw refused('board.stop: only the immutable authority requests a worker stop');
    const p = {cardId: text(raw?.cardId, 'cardId', 128), claimId: text(raw?.claimId, 'claimId', 100), worker: threadRef(raw?.worker)};
    if (!sameProject(p.worker.project, ctx.local)) throw refused('board.stop.worker: expected this exact worker host');
    const key = this.stopKey(ctx.shared.id, p.cardId, p.claimId), hash = fingerprint(p);
    const saved = this.core.journal.getSetting(key) as {hash: string; state: string} | undefined;
    if (saved && saved.hash !== hash) throw refused('board.stop: this claim is bound to another worker');
    if (saved?.state === 'stopped') return;
    const existing = this.stopping.get(key); if (existing) return existing;
    const work = (async () => {
      if (!this.authority(ctx.shared)) await this.pull(this.ownerContext(ctx.shared));
      const entry = this.journal.entry(ctx.shared.id, p.cardId);
      if (entry?.kind !== 'card' || entry.card.assignment?.claimId !== p.claimId || fingerprint(entry.card.assignment.worker) !== fingerprint(p.worker)) throw refused('board.stop: expected the current exact claim');
      this.core.journal.setSetting(key, {hash, state: 'stopping'});
      await this.core.sharedCompute?.stopBoardClaim(ctx.shared.id, p.claimId, p.worker);
      const binding = {sharedProjectId: ctx.shared.id, cardId: p.cardId, claimId: p.claimId};
      const bindingKey = `activity:shared:${p.worker.threadId}`;
      const owned = fingerprint(this.core.journal.getSetting(bindingKey) ?? null) === fingerprint(binding);
      const activity = this.core.activity.get(p.worker.threadId);
      const captured = [p.worker.threadId, activity.goal?.checklist?.threadId, activity.goal?.review?.reviewerThreadId].filter((id): id is string => !!id);
      if (activity.loop) throw refused('board.stop: another activity owns this worker; assignment retained');
      if (owned && activity.goal) {
        if (activity.goal) this.core.activity.control({threadId: p.worker.threadId, kind: 'goal', action: 'remove'});
        this.core.threads.stopTurn(p.worker.threadId);
        // Both calls capture their current scheduler/process records synchronously, before awaiting exit.
        await Promise.all(captured.flatMap(id => [this.core.scheduler.stopAndWait(id), this.core.procs.stopAndWait(id)]));
        if (fingerprint(this.core.journal.getSetting(bindingKey) ?? null) !== fingerprint(binding)) throw refused('board.stop: the user replaced the worker activity during stop');
      }
      const current = this.core.activity.get(p.worker.threadId);
      let unsettled: {threadId: string; processes: number; status?: string} | undefined;
      if (current.goal || current.loop || captured.some(id => {
        const processes = this.core.procs.liveCount(id);
        const status = processes > 0 ? undefined : this.core.journal.getThread(id)?.status ?? 'idle';
        if (processes > 0 || ['queued', 'running', 'waiting'].includes(status!)) {unsettled = {threadId: id, processes, status}; return true;}
        return false;
      })) {
        try {
          this.core.logs.warn('Shared board stop refused: worker execution is uncertain; assignment retained', {
            source: 'shared-board', event: 'shared-board.stop-refused', threadId: p.worker.threadId,
            data: {sharedProjectId: ctx.shared.id, cardId: p.cardId, claimId: p.claimId, goal: !!current.goal, loop: !!current.loop,
              ...(unsettled && {blockedThreadId: unsettled.threadId, processes: unsettled.processes, ...(unsettled.status && {status: unsettled.status})})},
          });
        } catch { /* Diagnostics must not replace the original refusal. */ }
        throw refused('board.stop: worker execution is uncertain; assignment retained');
      }
      this.check(ctx);
      this.core.journal.setSetting(key, {hash, state: 'stopped'});
    })();
    this.stopping.set(key, work);
    try { await work; } finally {this.stopping.delete(key);}
  }
  async start(p: RpcParams<'sharedBoard.start'>, connection?: Connection): Promise<SharedBoardReceipt> {
    let ctx = this.core.sharedProjects.scope(p, connection); this.check(ctx);
    const cardId = text(p.cardId, 'cardId', 128), claimId = text(p.claimId, 'claimId', 100);
    if (!this.authority(ctx.shared)) await this.pull(ctx);
    ctx = this.core.sharedProjects.scope(p, connection); this.check(ctx);
    const entry = this.journal.entry(ctx.shared.id, cardId);
    const card = entry?.kind === 'card' ? entry.card : null;
    const assignment = card?.assignment;
    if (!assignment || assignment.claimId !== claimId || assignment.worker.threadId !== p.threadId) throw refused('worker: expected the current accepted claim and its reserved worker');
    this.localWorker(ctx, assignment.worker, true);
    const stopKey = this.stopKey(ctx.shared.id, cardId, claimId);
    if (this.core.journal.getSetting(stopKey)) throw refused('claimId: this worker claim is stopping or stopped');
    await this.guardStart(ctx, assignment.worker);
    ctx = this.core.sharedProjects.scope(p, connection); this.check(ctx);
    // A second authority read closes delayed guard admission after release/delete/revoke.
    if (!this.authority(ctx.shared)) await this.pull(ctx);
    const current = this.journal.entry(ctx.shared.id, cardId);
    if (current?.kind !== 'card' || current.card.assignment?.claimId !== claimId) throw refused('claimId: reservation changed during start admission');
    if (this.core.journal.getSetting(stopKey)) throw refused('claimId: this worker claim is stopping or stopped');
    this.core.bus.afterCommit(() => this.core.sharedProjects.journal.transaction(() => this.core.sharedProjects.journal.once(`board-start:${ctx.shared.id}:${cardId}`, claimId, assignment.worker, () => {
      const activity = this.core.activity.get(p.threadId);
      if (activity.goal || activity.loop) throw refused('worker: expected a thread with no existing goal or loop');
      bindBoard(this.core, ctx, assignment.worker, cardId, claimId);
      this.core.activity.set({threadId: p.threadId, goal: {objective: current.card.text, review: true}}, {sharedProjectId: ctx.shared.id, cardId, claimId});
      return {ok: true};
    })));
    this.follow(p.threadId);
    try { await this.flushAssociation(ctx.shared.id); } catch (error) { if (!this.offline(error)) throw error; }
    return receipt(this, ctx, claimId, 'applied', cardId);
  }
  assertClaimOpen(sharedId: string, cardId: string, claimId: string): void {
    if (this.core.journal.getSetting(this.stopKey(sharedId, cardId, claimId))) throw refused('compute.claim: reservation is stopping or stopped');
  }
  private progress(p: BoardProgress): BoardProgress {
    if (!p) throw invalidParams('board.progress: expected a journalled goal');
    return {cardId: text(p.cardId, 'cardId', 128), claimId: text(p.claimId, 'claimId', 100), worker: threadRef(p.worker), goal: boardGoal(p.goal), sequence: integer(p.sequence, 'sequence', 1), reviewPassedAt: p.reviewPassedAt === null ? null : integer(p.reviewPassedAt, 'reviewPassedAt')};
  }
  private follow(threadId: string): void {
    for (const shared of this.core.sharedProjects.journal.all()) {
      const ctx = this.ownerContext(shared);
      if (shared.state !== 'active' || !shared.access.every(a => a.board)) continue;
      for (const entry of this.journal.entries(shared.id)) {
        if (entry.kind !== 'card' || !entry.card.assignment) continue;
        const {worker, claimId} = entry.card.assignment;
        if (!sameProject(worker.project, ctx.local) || worker.threadId !== threadId) continue;
        const thread = this.core.journal.getThread(threadId), activity = this.core.activity.get(threadId);
        const goal = thread?.projectId === ctx.local.projectId && !thread.archived ? boardGoal(goalOf(activity)) : null;
        const verdict = activity.goal?.review?.verdicts.at(-1);
        const reviewPassedAt = goal?.status === 'complete' && verdict?.verdict === 'pass' ? verdict.finishedAt : null;
        const previous = this.journal.progress(shared.id, entry.card.id);
        if (previous?.claimId === claimId && fingerprint({goal: previous.goal, reviewPassedAt: previous.reviewPassedAt}) === fingerprint({goal, reviewPassedAt})) continue;
        this.journal.putProgress(shared.id, {cardId: entry.card.id, claimId, worker, goal, reviewPassedAt, sequence: previous?.claimId === claimId ? previous.sequence + 1 : 1});
        this.schedule();
      }
    }
  }
  /** The existing board's card shape, with scoped attribution instead of a foreign goalThreadId. */
  visibleTodos(threadId: string, todos: Todo[], connection: Connection): Todo[] {
    if (connection.identity.principal !== 'agent') return todos;
    const allowed = new Map<string, boolean>();
    return todos.filter(todo => {
      if (!todo.shared) return true;
      const id = todo.shared.sharedProjectId;
      if (!allowed.has(id)) {
        try { this.check(this.core.sharedProjects.scope({threadId, sharedProjectId: id}, connection)); allowed.set(id, true); }
        catch {allowed.set(id, false);}
      }
      return allowed.get(id) === true;
    });
  }
  async updateTodo(p: RpcParams<'todos.update'>, connection: Connection): Promise<Todo> {
    const scope = {threadId: p.threadId, sharedProjectId: p.sharedProjectId!};
    const ctx = this.core.sharedProjects.scope(scope, connection); this.check(ctx);
    const current = this.journal.entry(ctx.shared.id, p.todoId);
    if (current?.kind !== 'card') throw refused('todoId: expected a live shared card');
    const base = {cardId: p.todoId, requestId: newId('board_')};
    if (p.goalThreadId !== undefined && (p.text !== undefined || p.status !== undefined && p.status !== 'open')) throw invalidParams('todos.update: link changes are separate from text or status edits');
    let command: SharedBoardCommand;
    if (p.goalThreadId) command = {...base, kind: 'claim', expectedRevision: current.card.revision, worker: {project: ctx.local, threadId: p.goalThreadId, address: projectAddress(ctx.local, p.goalThreadId)}};
    else if (p.goalThreadId === null) {
      if (!current.card.assignment) return this.todos(ctx.local.projectId).find(t => t.id === p.todoId && t.shared?.sharedProjectId === ctx.shared.id)!;
      command = {...base, kind: 'release', claimId: current.card.assignment.claimId};
    } else command = {...base, kind: 'update', ...(p.text === undefined ? {} : {text: p.text}), ...(p.status === undefined ? {} : {status: p.status})};
    const result = await this.apply({...scope, command}, connection);
    if (result.outcome === 'conflict' || result.outcome === 'deleted' || result.outcome === 'revoked' || command.kind === 'claim' && result.outcome === 'queued') throw refused('todoId: shared card claim requires an accepted authority reservation');
    return this.todos(ctx.local.projectId).find(t => t.id === p.todoId && t.shared?.sharedProjectId === ctx.shared.id)!;
  }
  todos(projectId: string): Todo[] {
    return this.core.sharedProjects.journal.all(projectId).filter(shared => shared.state === 'active' && shared.access.every(a => a.board)).flatMap(shared =>
      this.optimistic(shared.id, this.journal.snapshot(shared.id).cards).map(card => ({id: card.id, projectId, text: card.text, status: card.status, threadId: null, createdAt: card.createdAt, updatedAt: card.updatedAt,
        goalThreadId: card.assignment && sameProject(card.assignment.worker.project, this.core.sharedProjects.endpoints(shared).local) ? card.assignment.worker.threadId : null,
        ...(card.goal ? {goal: card.goal} : {}), shared: {sharedProjectId: shared.id, card}})));
  }
  beginClose(): void { this.closed = true; this.off(); if (this.timer) clearTimeout(this.timer); this.timer = null; }
  async close(): Promise<void> { this.beginClose(); await Promise.allSettled([...this.pending, ...this.flushing.values(), ...this.pulling.values(), ...this.stopping.values()]); }
}

export function registerSharedBoardMethods(core: Core): void {
  core.router.register('sharedBoard.get', (p, ctx) => core.sharedBoard.get(p, ctx.connection));
  core.router.register('sharedBoard.apply', (p, ctx) => core.sharedBoard.apply(p, ctx.connection));
  core.router.register('sharedBoard.start', (p, ctx) => core.sharedBoard.start(p, ctx.connection));
}
