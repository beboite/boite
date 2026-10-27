import { randomUUID } from 'node:crypto';
import type { ComposerChoice, ComposerQueuedPrompt, ComposerRecord, ComposerValue, RpcParams, ThreadSummary } from '@boite/contracts';
import type { Core } from './core.ts';
import type { Connection } from './router.ts';
import { invalidParams, messageOf, notFound, refused } from './errors.ts';
import { ComposerStorage, digest, recordKey, type Delivery } from './composer-storage.ts';
import { composerValue } from './composer-validation.ts';
import { steerUser, userSteeringUnavailable } from './threads/user-steering.ts';
import { DraftReservationLedger, type DraftOwnership } from './threads/draft-reservation-ledger.ts';
import { needsModelDiscovery } from './threads/selection.ts';
import { composerActivity, isComposerActivity } from './composer-activity.ts';
import { composerBatch } from './composer-batch.ts';

const choiceOf = (thread: ThreadSummary): ComposerChoice => ({ providerId: thread.providerId, accountId: thread.accountId, model: thread.model, effort: thread.effort, speed: thread.speed ?? null, permissionMode: thread.permissionMode });
const sameChoice = (a: ComposerChoice, b: ComposerChoice): boolean => a.providerId === b.providerId && a.accountId === b.accountId && a.model === b.model && a.effort === b.effort && (a.speed ?? null) === (b.speed ?? null) && a.permissionMode === b.permissionMode;

/** Durable owner outbox. No browser or subscription participates in execution. */
export class Composer {
  readonly storage: ComposerStorage;
  private closed = false;
  private scheduled = false;
  private readonly running = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, Pick<ComposerRecord, 'section' | 'id'>>();
  private readonly dirty = new Set<string>();
  private readonly captured = new Map<string, ComposerQueuedPrompt[]>();
  private readonly boundaries = new Map<string, string>();
  private stopWaiting!: () => void;
  private readonly stopped = new Promise<null>(resolve => { this.stopWaiting = () => resolve(null); });
  private readonly unsubscribe: () => void;
  private readonly connection: Connection = { id: 'core-composer', subscriptions: new Set(), identity: { principal: 'owner', sessionId: null, threadId: null }, sendEvent() {}, close() {} };

  constructor(private readonly core: Core) {
    this.storage = new ComposerStorage(core);
    this.unsubscribe = core.bus.onCommitted((name, payload) => {
      if (name === 'turn.toolCompleted') {
        const boundary = payload as { threadId: string; boundary: string };
        if (!this.storage.queued.has(recordKey('inputs', boundary.threadId))) return;
        this.boundaries.set(boundary.threadId, boundary.boundary);
        this.schedule([{ section: 'inputs', id: boundary.threadId }]);
      } else if (['turn.finished', 'thread.updated', 'permission.resolved', 'question.answered'].includes(name)) {
        const thread = payload as { threadId?: string; id?: string };
        this.schedule([{ section: 'inputs', id: thread.threadId ?? thread.id! }]);
      } else if (name === 'project.updated') this.schedule(this.storage.queued.values());
      else if (name === 'thread.removed' && !(payload as { undoable?: boolean }).undoable) {
        const { threadId } = payload as { threadId: string };
        this.storage.forgetThread(threadId);
        this.pending.delete(recordKey('inputs', threadId)); this.dirty.delete(recordKey('inputs', threadId));
        this.boundaries.delete(threadId);
      }
    });
    core.router.register('composer.list', (_params, ctx) => this.storage.list(ctx.connection.id));
    core.router.register('composer.asset.put', (params, ctx) => this.storage.putAsset(params.attachment, params.incognito === true, ctx.connection.id));
    core.router.register('composer.asset.get', (params, ctx) => this.storage.getAsset(params.assetId, ctx.connection.id));
    core.router.register('composer.put', (params, ctx) => this.put(params, ctx.connection));
  }

  start(): void {
    // Native submissions without confirmation stay held. A start admitted by
    // the durable turn ledger is never submitted a second time.
    for (const ref of this.storage.queued.values()) {
      const record = this.storage.get(ref.section, ref.id);
      for (const item of record.value?.input.queued ?? []) {
        const delivery = this.storage.delivery(item.id);
        if (delivery?.status === 'submitting') {
          const receipt = delivery.thread_id ? this.core.journal.turnRequest(delivery.thread_id, delivery.request_id) : null;
          if (receipt && !receipt.fingerprint.includes(':pending:')) this.storage.status(item.id, 'delivered');
          else if (receipt) this.storage.status(item.id, 'uncertain');
          else this.storage.release(item.id);
        }
      }
    }
    // Existing recovery holds every never-started turn. Server-owned accepted
    // queues may resume those safe rows; legacy client queues remain held.
    const delivered = this.core.journal.db.query("SELECT * FROM composer_deliveries WHERE status = 'delivered'").all() as Delivery[];
    for (const delivery of delivered) {
      if (!delivery.thread_id) continue;
      const thread = this.core.journal.getThread(delivery.thread_id);
      if (!thread || thread.archived || (thread.projectId && this.core.projects.require(thread.projectId).archived)) continue;
      const receipt = this.core.journal.turnRequest(delivery.thread_id, delivery.request_id);
      const turn = receipt && this.core.journal.getTurn(receipt.turn_id);
      if (turn?.queueHold && turn.startedAt === null) {
        try { this.core.threads.recoverTurn({ threadId: thread.id, turnId: turn.id, action: 'resume' }); }
        catch (error) { this.core.log('warn', `queued composer input remains held: ${messageOf(error)}`); }
      }
    }
    this.schedule(this.storage.queued.values());
  }

  put(params: RpcParams<'composer.put'>, connection: Connection): { accepted: boolean; record: ComposerRecord } {
    if (!params || !['inputs', 'drafts'].includes(params.section) || typeof params.id !== 'string' || !params.id || !Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0) throw invalidParams('composer.put: expected section inputs/drafts, non-empty id and non-negative expectedRevision');
    // Soft-deleted rows remain undoable. Missing rows cannot adopt an offline
    // client's old input again, regardless of its remembered CAS revision.
    if (params.section === 'inputs' && params.value !== null && !this.core.journal.db.query('SELECT 1 FROM threads WHERE id = ?').get(params.id)) {
      throw notFound('composer.id: expected an existing thread; this conversation was permanently deleted', { reason: 'thread-deleted', threadId: params.id, field: 'composer.id' });
    }
    this.storage.requireOwner(params, connection.id);
    const current = this.storage.get(params.section, params.id);
    if (current.revision !== params.expectedRevision) return { accepted: false, record: current };
    const value = composerValue(params.value);
    const captured = this.captured.get(recordKey(params.section, params.id)) ?? [];
    if (captured.some(item => !value?.input.queued.some(next => next.id === item.id && digest(next) === digest(item)))) return { accepted: false, record: current };
    if (value) {
      const thread = params.section === 'inputs' ? this.core.journal.getThread(params.id) : null;
      this.storage.validateAssets(value, this.storage.privateMode(params.section, params.id, value), connection.id);
      value.input.queued = value.input.queued.filter(item => this.storage.delivery(item.id)?.status !== 'delivered');
      for (const item of value.input.queued) {
        const delivery = this.storage.delivery(item.id);
        if (delivery && delivery.status !== 'delivered' && (delivery.section !== params.section || delivery.record_id !== params.id)) throw refused('composer.queued.id: this queued input already belongs to another composer');
        item.choice ??= item.request?.choice ?? value.choice ?? (thread ? choiceOf(thread) : undefined);
        if (params.section === 'drafts' && item === value.input.queued[0] && !item.request?.start) {
          item.request = { ...item.request, id: item.request?.id ?? this.requestId(item), choice: item.choice ?? null, queuedAt: item.request?.queuedAt ?? Date.now(),
            start: { projectId: value.draft?.projectId ?? this.core.projects.drafts().id, worktree: value.draft?.worktree ?? false, incognito: value.draft?.incognito === true } };
        }
        // A reconnect may retain an uncertain request but may not clear its hold.
        if (delivery?.status === 'uncertain') {
          value.input.paused = true;
          item.request = { ...item.request, id: item.request?.id ?? delivery.request_id, choice: item.choice ?? null, queuedAt: item.request?.queuedAt ?? Date.now(), failed: 'Delivery is unconfirmed; review this input before sending it as a new request.' };
        }
      }
    }
    const record = this.atomic(() => this.storage.save(params.section, params.id, value, connection));
    if (params.sendNow && params.section === 'inputs') this.boundaries.set(params.id, `manual-${randomUUID()}`);
    this.schedule([{ section: params.section, id: params.id }]);
    return { accepted: true, record };
  }

  private atomic<T>(write: () => T): T { return this.core.bus.afterCommit(() => this.core.journal.db.transaction(write)()); }

  private schedule(records: Iterable<Pick<ComposerRecord, 'section' | 'id'>>): void {
    if (this.closed) return;
    for (const record of records) {
      const key = recordKey(record.section, record.id);
      if (!this.storage.queued.has(key)) continue;
      if (this.running.has(key)) this.dirty.add(key);
      else this.pending.set(key, record);
    }
    if (this.scheduled || !this.pending.size) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.closed || this.core.stopping) return;
      const pending = [...this.pending.values()]; this.pending.clear();
      for (const record of pending) {
        const key = recordKey(record.section, record.id);
        if (this.running.has(key)) continue;
        const task = this.pump(record.section, record.id).catch(error => this.core.log('error', `composer delivery failed: ${messageOf(error)}`)).finally(() => {
          this.running.delete(key); this.captured.delete(key);
          if (this.dirty.delete(key)) this.schedule([record]);
        });
        this.running.set(key, task);
      }
    });
  }

  private async pump(section: ComposerRecord['section'], id: string): Promise<void> {
    const key = recordKey(section, id);
    while (!this.closed && !this.core.stopping) {
      const record = this.storage.get(section, id), value = record.value;
      if (!value || !value.input.queued.length) { this.storage.queued.delete(key); return; }
      if (value.input.paused) return;
      const item = value.input.queued[0]!;
      const delivery = this.storage.delivery(item.id);
      if (delivery?.status === 'delivered') { this.complete(section, id, item.id); continue; }
      if (delivery?.status === 'uncertain' || item.request?.failed || item.request?.sent) {
        this.hold(section, id, item.id, item.request?.failed ?? 'Delivery is unconfirmed; review before sending a new request.'); return;
      }
      this.captured.set(key, section === 'drafts' ? value.input.queued : [item]);
      try {
        if (section === 'drafts') { await this.launch(record, item); return; }
        const thread = this.core.journal.getThread(id);
        if (!thread || thread.archived || (thread.projectId && this.core.projects.require(thread.projectId).archived)) return;
        if (this.core.threads.listPermissions(id).length || this.core.threads.listQuestions(id).some(question => !question.async)) return;
        const boundary = this.boundaries.get(id);
        const choice = item.choice;
        if (!choice) throw refused('No agent selection was saved for this queued prompt. Choose an agent and enqueue it again.');
        const account = this.core.accounts.require(choice.accountId);
        if (account.providerId !== choice.providerId || account.status === 'unauthenticated') throw refused('The queued account is unavailable; choose an account and enqueue this input again.');
        const active = ['running', 'queued', 'waiting'].includes(thread.status) || this.core.threads.runner.handles.has(id);
        const running = active ? this.core.journal.runningTurn(id) : null;
        if (active && (!boundary || boundary === item.afterBoundary || item.request || isComposerActivity(item.text) || !sameChoice(choice, choiceOf({ ...thread, ...running?.execution })) || userSteeringUnavailable(this.core, this.core.threads, id, running) !== null)) return;
        const batch = composerBatch(value.input.queued, this.storage);
        const attachments = batch.attachments;
        this.captured.set(key, batch.entries);
        if (active) {
          const turn = running;
          if (!turn) return;
          for (const entry of batch.entries) this.reserve(record, entry, id, batch.requestId);
          const accepted = await Promise.race([this.stopped, steerUser(this.core, this.core.threads, { threadId: id, turnId: turn.id, prompt: batch.text, attachments, previewReferences: batch.previewReferences, clientRequestId: batch.requestId, expectedSelectionVersion: thread.selectionVersion ?? 0 })]);
          if (!accepted || this.closed) return;
          if (!accepted.accepted) { for (const entry of batch.entries) this.storage.release(entry.id); this.boundaries.delete(id); return; }
          this.complete(section, id, batch.entries.map(entry => entry.id)); continue;
        }
        this.boundaries.delete(id);
        const provider = this.core.providers.require(choice.providerId);
        if (needsModelDiscovery(provider, choice.accountId, choice.model, choice.effort, choice.speed ?? null)) {
          await this.core.router.dispatch('providers.probe', { providerId: choice.providerId, accountId: choice.accountId, ...(provider.protocol === 'acp' && choice.model !== null && choice.effort !== null ? { model: choice.model } : {}) }, { connection: this.connection });
        }
        // A discovery RPC can yield while the user archives the target or stops the core.
        const current = this.core.journal.getThread(id);
        if (this.closed || this.core.stopping || !current || current.archived || (current.projectId && this.core.projects.require(current.projectId).archived)) return;
        if (current.projectId) await this.core.projects.requireFolder(current.projectId);
        const activity = composerActivity(item.text, this.core.clients.current()?.experiments);
        this.atomic(() => {
          const target = this.core.journal.getThread(id);
          if (!target || target.archived || (target.projectId && this.core.projects.require(target.projectId).archived)) return;
          for (const entry of batch.entries) this.reserve(record, entry, id, batch.requestId);
          if (activity) {
            if (item.previewReferences?.length) throw refused('Activity commands do not accept page references.');
            this.core.activity.set({ threadId: id, ...activity, attachments }, choice);
          } else this.core.threads.startTurn(id, batch.text, attachments, current.selectionVersion ?? 0, undefined, undefined, batch.requestId, undefined, batch.previewReferences, undefined, null, undefined, choice);
          this.complete(section, id, batch.entries.map(entry => entry.id));
        });
      } catch (error) {
        for (const entry of this.captured.get(key) ?? [item]) {
          const pending = this.storage.delivery(entry.id);
          if (pending?.status === 'submitting') this.storage.status(entry.id, 'uncertain');
        }
        this.hold(section, id, item.id, messageOf(error)); return;
      } finally { this.captured.delete(key); }
    }
  }

  private requestId(item: ComposerQueuedPrompt): string { return `composer_${digest(item.id)}`; }

  private reserve(record: ComposerRecord, item: ComposerQueuedPrompt, threadId: string, requestId: string): void {
    this.storage.reserve({ id: item.id, section: record.section, record_id: record.id, status: 'submitting', thread_id: threadId, request_id: requestId, fingerprint: digest(item) }, this.storage.privateMode(record.section, record.id, record.value));
  }

  private complete(section: ComposerRecord['section'], id: string, itemId: string | string[]): void {
    const ids = new Set(typeof itemId === 'string' ? [itemId] : itemId);
    this.atomic(() => {
      for (const itemId of ids) this.storage.status(itemId, 'delivered');
      const record = this.storage.get(section, id);
      if (!record.value) return;
      record.value.input.queued = record.value.input.queued.filter(item => !ids.has(item.id));
      this.storage.save(section, id, record.value);
    });
  }

  private hold(section: ComposerRecord['section'], id: string, itemId: string, reason: string): void {
    const record = this.storage.get(section, id);
    const item = record.value?.input.queued.find(item => item.id === itemId);
    if (!record.value || !item) return;
    item.request = { ...item.request, id: item.request?.id ?? this.requestId(item), choice: item.choice ?? null, queuedAt: item.request?.queuedAt ?? Date.now(), failed: reason };
    record.value.input.paused = true;
    this.atomic(() => this.storage.save(section, id, record.value));
  }

  private async launch(record: ComposerRecord, item: ComposerQueuedPrompt): Promise<void> {
    const value = record.value!, choice = item.choice;
    if (!choice) throw refused('No agent selection was saved for this draft. Choose an agent and enqueue it again.');
    const draft = value.draft;
    const projectId = item.request?.start?.projectId ?? draft?.projectId ?? this.core.projects.drafts().id;
    if (this.core.projects.require(projectId).archived) return;
    const launchId = `draft-${digest([record.section, record.id, item.id])}`;
    const previous = this.storage.delivery(launchId);
    if (previous) throw refused(previous.status === 'delivered' ? 'This draft already started a conversation. Review its queued messages before starting a new one.' : 'Core restarted during draft creation. Review this draft before starting a new one.');
    const params: RpcParams<'threads.create'> = { projectId, providerId: choice.providerId, accountId: choice.accountId, model: choice.model ?? undefined, effort: choice.effort, speed: choice.speed ?? null, permissionMode: choice.permissionMode, title: item.text.slice(0, 120),
      ...((item.request?.start?.worktree ?? draft?.worktree) ? { worktree: {} } : {}), ...((item.request?.start?.incognito ?? draft?.incognito) ? { incognito: true } : {}) };
    await this.core.projects.requireFolder(projectId);
    // Reuse discovery and draft workspace machinery, but keep publication and
    // the queue transfer in one commit so restart cannot create another thread.
    const provider = this.core.providers.require(choice.providerId);
    if (needsModelDiscovery(provider, choice.accountId, choice.model, choice.effort, choice.speed ?? null)) {
      await this.core.router.dispatch('providers.probe', { providerId: choice.providerId, accountId: choice.accountId, ...(provider.protocol === 'acp' && choice.model !== null && choice.effort !== null ? { model: choice.model } : {}) }, { connection: this.connection });
    }
    const ledger = new DraftReservationLedger(this.core);
    const mutations: DraftOwnership[] = [];
    const beforeMutation = (ownership: DraftOwnership) => { mutations.push(ownership); return ledger.record(ownership); };
    this.storage.reserve({ id: launchId, section: record.section, record_id: record.id, status: 'creating', thread_id: null, request_id: launchId, fingerprint: digest(params) }, this.storage.privateMode(record.section, record.id, value));
    const creation = this.core.threads.creation;
    let thread: ThreadSummary | undefined;
    const cleanup = async () => {
      let clean = true;
      for (const ownership of mutations) if (!await ledger.cleanup(ownership)) clean = false;
      if (clean) this.storage.release(launchId);
    };
    try {
      const planned = params.worktree ? await creation.createInWorktree(params, false, beforeMutation) : creation.create(params, undefined, false, beforeMutation);
      thread = planned;
      if (this.closed || this.core.stopping || this.core.projects.require(projectId).archived) { await cleanup(); return; }
      this.atomic(() => {
        creation.publish(planned);
        const latest = this.storage.get(record.section, record.id).value!;
        const transferred: ComposerValue = { ...latest, input: { ...latest.input, text: '', attachments: [], previewReferences: [], queued: latest.input.queued }, draft: undefined };
        this.storage.save('inputs', planned.id, transferred, this.storage.owner(record));
        const retained = { ...latest, input: { ...latest.input, queued: [] } };
        this.storage.save(record.section, record.id, retained.input.text || retained.input.attachments.length || retained.input.previewReferences?.length ? retained : null);
        this.storage.status(launchId, 'delivered', planned.id);
        ledger.forget(planned.id);
      });
      this.schedule([{ section: 'inputs', id: planned.id }]);
    } catch (error) {
      // Only this launch's unpublished workspaces are ours to remove. A crash
      // or failed cleanup retains its receipt rather than risking a duplicate.
      if ((!thread || !this.core.journal.getThread(thread.id)) && !mutations.some(ownership => this.core.journal.getThread(ownership.threadId))) await cleanup();
      throw error;
    }
  }

  stop(): void { this.closed = true; this.unsubscribe(); this.stopWaiting(); }
  async close(): Promise<void> { this.stop(); await Promise.all(this.running.values()); }
}
