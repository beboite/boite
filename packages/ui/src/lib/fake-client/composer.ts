import { sha256 } from '@noble/hashes/sha2.js';
import {
  answerAttachmentError, ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES, PREVIEW_REFERENCES_PER_TURN,
  decodedBytes, type Attachment, type ComposerChoice, type ComposerQueuedPrompt,
  type ComposerRecord, type ComposerValue, type PreviewReference, type RpcEventName, type RpcEvents,
} from '@boite/contracts';
import { activityCommand, isActivityCommand } from '../activity-command';
import type { FakeContext, FakeMethods } from './context';
import { refusal } from './shared';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const keyOf = (section: ComposerRecord['section'], id: string) => JSON.stringify([section, id]);

/** One fake core's durable composer, shared by explicit peer clients only. */
export class FakeComposerState {
  readonly records = new Map<string, ComposerRecord>();
  readonly assets = new Map<string, Attachment>();
  readonly clients = new Set<FakeContext>();
  readonly consumed = new Map<string, Set<string>>();
  readonly delivering = new Map<string, ComposerQueuedPrompt[]>();
  private pending = false;
  private forced = new Set<string>();
  private methods = new Map<FakeContext, () => FakeMethods>();
  private boundaries = new Map<string, string>();

  attach(ctx: FakeContext, methods: () => FakeMethods): void {
    this.clients.add(ctx);
    this.methods.set(ctx, methods);
  }

  detach(ctx: FakeContext): void { this.clients.delete(ctx); this.methods.delete(ctx); }

  write(section: ComposerRecord['section'], id: string, value: ComposerValue | null): ComposerRecord {
    const key = keyOf(section, id);
    const record = { section, id, revision: (this.records.get(key)?.revision ?? 0) + 1, updatedAt: Date.now(), value: copy(value) };
    this.records.set(key, record);
    for (const client of this.clients) client.emit('composer.updated', copy(record));
    return copy(record);
  }

  observe<E extends RpcEventName>(ctx: FakeContext, event: E, payload: RpcEvents[E]): void {
    if (event === 'composer.updated') return;
    if (event === 'turn.toolCompleted') {
      const boundary = payload as RpcEvents['turn.toolCompleted'];
      this.boundaries.set(boundary.threadId, boundary.boundary);
    }
    if (event === 'thread.removed') {
      const id = (payload as RpcEvents['thread.removed']).threadId;
      if (this.records.get(keyOf('inputs', id))?.value) this.write('inputs', id, null);
    }
    if (['turn.finished', 'turn.toolCompleted', 'permission.resolved', 'question.answered', 'thread.updated'].includes(event)) this.schedule(ctx);
  }

  schedule(ctx: FakeContext, sendNow = false, only?: string): void {
    if (sendNow && only !== undefined) this.forced.add(only);
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      if (!this.clients.has(ctx)) return;
      for (const [key, row] of this.records) {
        if (!row.value?.input.queued.length || row.value.input.paused || this.delivering.has(key)) continue;
        void this.deliver(ctx, key, this.forced.delete(row.id));
      }
    });
  }

  private materialize(entries: ComposerQueuedPrompt[]): { prompt: string; attachments: Attachment[]; previewReferences: PreviewReference[] } {
    let text = '';
    const attachments: Attachment[] = [], previewReferences: PreviewReference[] = [];
    const ids = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (index) text += '\n\n';
      const offset = text.length;
      text += entry.text;
      for (const file of entry.attachments) {
        const asset = this.assets.get(file.assetId);
        if (!asset) throw refusal(`assetId ${file.assetId}: expected an uploaded composer attachment`);
        attachments.push(copy(asset));
      }
      for (const reference of entry.previewReferences ?? []) {
        let id = reference.id, suffix = 0;
        while (ids.has(id)) id = `${reference.id.slice(0, 60)}-queue-${++suffix}`;
        ids.add(id);
        previewReferences.push({ ...reference, id, ...(reference.mention ? { mention: { start: offset + reference.mention.start, end: offset + reference.mention.end } } : {}) });
      }
    }
    return { prompt: text, attachments, previewReferences };
  }

  private batch(queue: ComposerQueuedPrompt[]): ComposerQueuedPrompt[] {
    const head = queue[0]!;
    if (head.request || isActivityCommand(head.text)) return [head];
    const entries: ComposerQueuedPrompt[] = [];
    let files = 0, bytes = 0, refs = 0;
    for (const entry of queue) {
      const nextBytes = entry.attachments.reduce((sum, file) => sum + decodedBytes(this.assets.get(file.assetId)?.data ?? ''), 0);
      if (entries.length && (entry.request || isActivityCommand(entry.text) || JSON.stringify(entry.choice) !== JSON.stringify(head.choice) || files + entry.attachments.length > ATTACHMENTS_PER_TURN || bytes + nextBytes > ATTACHMENTS_TOTAL_MAX_BYTES || refs + (entry.previewReferences?.length ?? 0) > PREVIEW_REFERENCES_PER_TURN)) break;
      entries.push(entry); files += entry.attachments.length; bytes += nextBytes; refs += entry.previewReferences?.length ?? 0;
    }
    return entries;
  }

  private async deliver(ctx: FakeContext, key: string, sendNow: boolean): Promise<void> {
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
    if (running && (head.request || isActivityCommand(head.text) || (!sendNow && (!boundary || head.afterBoundary === boundary)))) return;
    const entries = this.batch(value.input.queued);
    this.delivering.set(key, entries);
    try {
      const payload = this.materialize(entries);
      const requestId = head.request?.id ?? head.id;
      if (running) {
        const turn = thread.turns.findLast(turn => turn.status === 'running');
        if (!turn || JSON.stringify(choiceOf({ ...thread, ...turn.execution })) !== JSON.stringify(choiceOf(head.choice ?? thread))) return;
        const outcome = await methods['turns.steer']({ threadId: row.id, turnId: turn.id, ...payload, clientRequestId: requestId, expectedSelectionVersion: thread.selectionVersion ?? 0 });
        if (!outcome.accepted) return;
      } else {
        const command = activityCommand(payload.prompt);
        if (command) await methods['threads.activity.set']({ threadId: row.id, ...command, ...(payload.attachments.length ? { attachments: payload.attachments } : {}) });
        else {
          const chosen = head.request?.choice ?? head.choice;
          const selection = choiceOf(thread);
          if (chosen) Object.assign(thread, chosen);
          try { await methods['turns.start']({ threadId: row.id, ...payload, clientRequestId: requestId }); }
          finally { Object.assign(thread, selection); }
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
      const thread = await methods['threads.create']({ ...selection, ...(model ? { model } : {}), projectId, title: head.text.slice(0, 60), clientRequestId: head.request?.id ?? head.id, ...(value.draft.worktree ? { worktree: {} } : {}) });
      const transferred = copy(value);
      delete transferred.draft;
      transferred.input.text = ''; transferred.input.attachments = []; transferred.input.previewReferences = [];
      this.write('inputs', thread.id, transferred);
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
    'composer.list': async () => copy([...state.records.values()]),
    'composer.put': async params => {
      const key = keyOf(params.section, params.id);
      const existing = state.records.get(key) ?? { section: params.section, id: params.id, revision: 0, updatedAt: 0, value: null };
      if (params.expectedRevision !== existing.revision) return { accepted: false, record: copy(existing) };
      const value = copy(params.value);
      if (value?.draft?.incognito || (params.section === 'inputs' && ctx.threads.get(params.id)?.incognito)) throw refusal('incognito drafts stay in memory');
      const locked = state.delivering.get(key);
      if (locked?.some((entry, index) => JSON.stringify(value?.input.queued[index]) !== JSON.stringify(entry))) return { accepted: false, record: copy(existing) };
      if (value) {
        const consumed = state.consumed.get(key);
        value.input.queued = value.input.queued.filter(entry => !consumed?.has(entry.id));
        const selected = params.section === 'inputs' ? ctx.threads.get(params.id) : null;
        for (const queued of value.input.queued) if (!queued.choice && selected) queued.choice = choiceOf(selected);
        for (const file of [...value.input.attachments, ...value.input.queued.flatMap(entry => entry.attachments)]) if (!state.assets.has(file.assetId)) throw refusal(`assetId ${file.assetId}: expected an uploaded composer attachment`);
      }
      const record = state.write(params.section, params.id, value);
      state.schedule(ctx, params.sendNow === true, params.id);
      return { accepted: true, record };
    },
    'composer.asset.put': async ({ attachment, incognito }) => {
      if (incognito) throw refusal('incognito composer attachments stay in memory');
      const error = answerAttachmentError([attachment]);
      if (error) throw refusal(error.message);
      const bytes = sha256(new TextEncoder().encode(JSON.stringify(attachment)));
      const assetId = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      state.assets.set(assetId, copy(attachment));
      return { assetId };
    },
    'composer.asset.get': async ({ assetId }) => {
      const referenced = [...state.records.values()].some(row => row.value && [...row.value.input.attachments, ...row.value.input.queued.flatMap(entry => entry.attachments)].some(file => file.assetId === assetId));
      const attachment = state.assets.get(assetId);
      if (!referenced || !attachment) throw refusal(`assetId ${assetId}: expected a referenced composer attachment`);
      return copy(attachment);
    },
  };
}
