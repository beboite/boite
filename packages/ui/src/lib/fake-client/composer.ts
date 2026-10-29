import { sha256 } from '@noble/hashes/sha2.js';
import {
  answerAttachmentError, composerBatch, composerActivity, isComposerActivity, RpcErrorCode, type Attachment, type ComposerChoice, type ComposerQueuedPrompt,
  type ComposerRecord, type ComposerValue, type PreviewReference, type RpcEventName, type RpcEvents,
} from '@boite/contracts';
import { RpcFailure } from '../client';
import { secureId } from '../secure-id';
import type { FakeContext, FakeMethods } from './context';
import { refusal } from './shared';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const keyOf = (section: ComposerRecord['section'], id: string) => JSON.stringify([section, id]);
/** Permission mode stays live; the other execution settings remain frozen. */
function sameExecutionChoice(a: ComposerChoice, b: ComposerChoice): boolean {
  return a.providerId === b.providerId && a.accountId === b.accountId && a.model === b.model
    && a.effort === b.effort && (a.speed ?? null) === (b.speed ?? null);
}

/** One fake core's durable composer, shared by explicit peer clients only. */
export class FakeComposerState {
  readonly records = new Map<string, ComposerRecord>();
  readonly assets = new Map<string, Attachment>();
  readonly clients = new Set<FakeContext>();
  readonly consumed = new Map<string, Set<string>>();
  readonly delivering = new Map<string, ComposerQueuedPrompt[]>();
  readonly owners = new Map<string, FakeContext>();
  readonly assetOwners = new Map<string, FakeContext>();
  private pending = false;
  private methods = new Map<FakeContext, () => FakeMethods>();
  private boundaries = new Map<string, string>();

  attach(ctx: FakeContext, methods: () => FakeMethods): void {
    this.clients.add(ctx);
    this.methods.set(ctx, methods);
  }

  detach(ctx: FakeContext): void {
    this.clients.delete(ctx); this.methods.delete(ctx);
    for (const [key, owner] of this.owners) if (owner === ctx) {
      this.records.delete(key); this.owners.delete(key);
    }
    for (const [id, owner] of this.assetOwners) if (owner === ctx) { this.assets.delete(id); this.assetOwners.delete(id); }
  }

  visible(key: string, ctx: FakeContext): boolean { return !this.owners.has(key) || this.owners.get(key) === ctx; }


  forgetThread(id: string): void {
    const key = keyOf('inputs', id);
    this.records.delete(key); this.consumed.delete(key);
    this.boundaries.delete(id);
  }

  write(section: ComposerRecord['section'], id: string, value: ComposerValue | null, owner?: FakeContext): ComposerRecord {
    const key = keyOf(section, id);
    const record = { section, id, revision: (this.records.get(key)?.revision ?? 0) + 1, updatedAt: Date.now(), value: copy(value) };
    if (owner) this.owners.set(key, owner);
    this.records.set(key, record);
    // As the core, a boundary or a Send now lasts only while the queue holds something.
    if (section === 'inputs' && !value?.input.queued.length) this.boundaries.delete(id);
    for (const client of this.clients) if (this.visible(key, client)) client.emit('composer.updated', copy(record));
    return copy(record);
  }

  observe<E extends RpcEventName>(ctx: FakeContext, event: E, payload: RpcEvents[E]): void {
    if (event === 'composer.updated') return;
    if (event === 'turn.toolCompleted') {
      const boundary = payload as RpcEvents['turn.toolCompleted'];
      if (this.records.get(keyOf('inputs', boundary.threadId))?.value?.input.queued.length) this.boundaries.set(boundary.threadId, boundary.boundary);
    }
    if (event === 'thread.removed') {
      const { threadId, undoable } = payload as RpcEvents['thread.removed'];
      if (!undoable) this.forgetThread(threadId);
    }
    if (['turn.finished', 'turn.toolCompleted', 'permission.resolved', 'question.answered', 'thread.updated'].includes(event)) this.schedule(ctx);
  }

  /** Send now is a boundary of its own, as the core's: it waits out a request and goes at the next steering attempt. */
  sendNow(id: string): void { this.boundaries.set(id, `manual-${secureId()}`); }

  schedule(ctx: FakeContext): void {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      if (!this.clients.has(ctx)) return;
      for (const [key, row] of this.records) {
        if (!row.value?.input.queued.length || row.value.input.paused || this.delivering.has(key)) continue;
        void this.deliver(this.owners.get(key) ?? ctx, key);
      }
    });
  }

  private async deliver(ctx: FakeContext, key: string): Promise<void> {
    const row = this.records.get(key);
    const value = row?.value;
    const methods = this.methods.get(ctx)?.();
    if (!row || !value || !methods) return;
    const head = value.input.queued[0]!;
    if (head.request?.failed !== undefined) return;
    if (row.section === 'drafts') { await this.launch(ctx, row, methods); return; }
    const thread = ctx.threads.get(row.id);
    if (!thread || thread.archived || ['queued', 'waiting'].includes(thread.status)) return;
    if ([...ctx.pendingPermissions.values()].some(item => item.request.threadId === row.id) || [...ctx.pendingQuestions.values()].some(item => item.request.threadId === row.id && !item.request.async)) return;
    const running = thread.status === 'running';
    const boundary = this.boundaries.get(row.id);
    if (running && (head.request || isComposerActivity(head.text) || !boundary || head.afterBoundary === boundary)) return;
    const batch = composerBatch(value.input.queued, id => {
      const asset = this.assets.get(id);
      if (!asset) throw refusal(`assetId ${id}: expected an uploaded composer attachment`);
      return copy(asset);
    });
    const entries = batch.entries;
    this.delivering.set(key, entries);
    try {
      const payload = { prompt: batch.text, attachments: batch.attachments, previewReferences: batch.previewReferences };
      const requestId = head.request?.id ?? head.id;
      if (running) {
        const turn = thread.turns.findLast(turn => turn.status === 'running');
        if (!turn || !sameExecutionChoice(choiceOf({ ...thread, ...turn.execution }), choiceOf(head.choice ?? thread))) return;
        const outcome = await methods['turns.steer']({ threadId: row.id, turnId: turn.id, ...payload, clientRequestId: requestId, expectedSelectionVersion: thread.selectionVersion ?? 0 });
        if (!outcome.accepted) { this.boundaries.delete(row.id); return; }
      } else {
        this.boundaries.delete(row.id);
        const command = composerActivity(payload.prompt, head.experiments ?? ctx.clientPreferences?.experiments ?? []);
        if (command) await methods['threads.activity.set']({ threadId: row.id, ...command, ...(payload.attachments.length ? { attachments: payload.attachments } : {}) });
        else {
          const chosen = head.request?.choice ?? head.choice;
          const selection = choiceOf(thread);
          if (chosen) Object.assign(thread, chosen, { permissionMode: selection.permissionMode });
          // `turns.start` fixes the turn's execution before its first await: the whole picker goes back at once, before any update can land.
          const started = methods['turns.start']({ threadId: row.id, ...payload, clientRequestId: requestId });
          if (chosen) Object.assign(thread, selection);
          await started;
        }
      }
      const consumed = this.consumed.get(key) ?? new Set<string>();
      for (const entry of entries) consumed.add(entry.id);
      this.consumed.set(key, consumed);
      const current = copy(this.records.get(key)?.value ?? value);
      current.input.queued = current.input.queued.filter(item => !consumed.has(item.id));
      this.write('inputs', row.id, current);
    } catch (error) {
      const current = this.records.get(key)?.value;
      if (current) {
        const held = copy(current);
        held.input.paused = true;
        const first = held.input.queued[0];
        if (first) first.request = { id: first.request?.id ?? first.id, choice: first.request?.choice ?? first.choice ?? null, queuedAt: first.request?.queuedAt ?? Date.now(), ...first.request, failed: error instanceof Error ? error.message : String(error) };
        this.write(row.section, row.id, held);
      }
    } finally { this.delivering.delete(key); }
  }

  private async launch(ctx: FakeContext, row: ComposerRecord, methods: FakeMethods): Promise<void> {
    const value = row.value!, head = value.input.queued[0]!;
    const key = keyOf(row.section, row.id);
    const choice = head.request?.choice ?? head.choice ?? value.choice;
    if (!choice || !value.draft) return;
    this.delivering.set(key, [head]);
    try {
      const projectId = value.draft.projectId ?? (await methods['projects.drafts']({})).id;
      const { model, ...selection } = choice;
      const thread = await methods['threads.create']({ ...selection, ...(model ? { model } : {}), projectId, title: head.text.slice(0, 60), clientRequestId: head.request?.id ?? head.id, ...(value.draft.worktree ? { worktree: {} } : {}), ...(value.draft.incognito ? { incognito: true } : {}) });
      const transferred = copy(value);
      delete transferred.draft;
      transferred.input.text = ''; transferred.input.attachments = []; transferred.input.previewReferences = [];
      this.write('inputs', thread.id, transferred, this.owners.get(key));
      const kept = copy(this.records.get(key)?.value ?? value);
      kept.input.queued = [];
      this.write('drafts', row.id, kept.input.text || kept.input.attachments.length || kept.input.previewReferences?.length ? kept : null);
      // Peers share composer metadata. The fixture's owning core creates and runs the thread.
      this.schedule(ctx);
    } catch (error) {
      const held = copy(value);
      held.input.paused = true;
      const first = held.input.queued[0]!;
      first.request = { id: first.request?.id ?? first.id, choice, queuedAt: Date.now(), ...first.request, failed: error instanceof Error ? error.message : String(error) };
      this.write('drafts', row.id, held);
    } finally { this.delivering.delete(key); }
  }
}

function choiceOf(thread: ComposerChoice): ComposerChoice {
  return { providerId: thread.providerId, accountId: thread.accountId, permissionMode: thread.permissionMode, model: thread.model, effort: thread.effort, speed: thread.speed ?? null };
}

export function composerMethods(ctx: FakeContext, methods: () => FakeMethods): Pick<FakeMethods, 'composer.list' | 'composer.put' | 'composer.asset.put' | 'composer.asset.get'> {
  const state = ctx.composer;
  state.attach(ctx, methods);
  return {
    'composer.list': async () => copy([...state.records].filter(([key]) => state.visible(key, ctx)).map(([, row]) => row)),
    'composer.put': async params => {
      if (params.section === 'inputs' && params.value !== null && !ctx.threads.has(params.id)
        && ![...ctx.deletedThreads.values()].some(family => family.threads.some(thread => thread.id === params.id))) {
        throw new RpcFailure({ code: RpcErrorCode.NotFound, message: 'composer.id: expected an existing thread; this conversation was permanently deleted', data: { reason: 'thread-deleted', threadId: params.id, field: 'composer.id' } });
      }
      const key = keyOf(params.section, params.id);
      if (!state.visible(key, ctx)) throw new RpcFailure({ code: RpcErrorCode.NotFound, message: 'composer.id: this private composer belongs to another connection' });
      const existing = state.records.get(key) ?? { section: params.section, id: params.id, revision: 0, updatedAt: 0, value: null };
      if (params.expectedRevision !== existing.revision) return { accepted: false, record: copy(existing) };
      const value = copy(params.value);
      const privateMode = state.owners.has(key) || value?.draft?.incognito || (params.section === 'inputs' && ctx.threads.get(params.id)?.incognito);
      if (privateMode && existing.revision && !state.owners.has(key)) throw refusal('composer: a persisted composer cannot become incognito; use a new draft');
      const locked = state.delivering.get(key);
      if (locked?.some((entry, index) => JSON.stringify(value?.input.queued[index]) !== JSON.stringify(entry))) return { accepted: false, record: copy(existing) };
      if (value) {
        const consumed = state.consumed.get(key);
        value.input.queued = value.input.queued.filter(entry => !consumed?.has(entry.id));
        const selected = params.section === 'inputs' ? ctx.threads.get(params.id) : null;
        for (const queued of value.input.queued) {
          if (!queued.choice && selected) queued.choice = choiceOf(selected);
          // The first experiments the core saw for an item stay its own; an app that sent none lends its current ones.
          const previous = existing.value?.input.queued.find(previous => previous.id === queued.id);
          queued.experiments = previous?.experiments ?? queued.experiments ?? ctx.clientPreferences?.experiments ?? [];
          // The core stamps the origin it first saw; the fake's one connection names no app.
          queued.sentFrom = previous?.sentFrom !== undefined ? previous.sentFrom : null;
        }
        for (const file of [...value.input.attachments, ...value.input.queued.flatMap(entry => entry.attachments)]) if (!state.assets.has(file.assetId) || (state.assetOwners.has(file.assetId) && (!privateMode || state.assetOwners.get(file.assetId) !== ctx))) throw refusal(`assetId ${file.assetId}: expected an uploaded composer attachment`);
      }
      const record = state.write(params.section, params.id, value, privateMode ? ctx : undefined);
      if (params.section === 'inputs' && params.sendNow && value?.input.queued.length) state.sendNow(params.id);
      state.schedule(ctx);
      return { accepted: true, record };
    },
    'composer.asset.put': async ({ attachment, incognito }) => {
      const error = answerAttachmentError([attachment]);
      if (error) throw refusal(error.message);
      const bytes = sha256(new TextEncoder().encode(JSON.stringify(attachment)));
      const assetId = `${incognito ? `private-${ctx.composerClientId}-` : ''}${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
      if (incognito) state.assetOwners.set(assetId, ctx);
      state.assets.set(assetId, copy(attachment));
      return { assetId };
    },
    'composer.asset.get': async ({ assetId }) => {
      const referenced = [...state.records].some(([key, row]) => state.visible(key, ctx) && row.value && [...row.value.input.attachments, ...row.value.input.queued.flatMap(entry => entry.attachments)].some(file => file.assetId === assetId));
      const attachment = state.assets.get(assetId);
      if (!referenced || !attachment) throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `assetId ${assetId}: expected a referenced composer attachment` });
      return copy(attachment);
    },
  };
}
