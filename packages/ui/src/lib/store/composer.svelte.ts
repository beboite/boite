import { RpcErrorCode, PREVIEW_REFERENCES_PER_TURN, previewReferencesError, type PreviewReference } from '@boite/contracts';
import type { Attachment } from '@boite/contracts';
import { activityCommand } from '../activity-command';
import { RpcFailure, readyAgain, wasDropped } from '../client';
import { titleFrom } from '../format';
import { DRAFT_STASH_KEY } from '../prefs';
import { editPreviewMentions, insertPreviewMention } from '../preview-mentions';
import { showPreviewReference } from '../preview-navigation';
import { strings } from '../strings';
import type { Choice } from '../store.svelte';
import type { StoreContext } from './context';

/** The unsent prompt of each thread, and the send path that turns one into a turn. */
export class Composer {
  /**
   * Unsent prompts survive thread switches and the settings page, images and
   * all: a prompt queued while a turn runs keeps the pictures it was written
   * with, so the pair goes out together when its turn comes.
   */
  composerStates = $state<Record<string, {
    text: string;
    attachments: Attachment[];
    previewReferences?: PreviewReference[];
    selection?: { start: number; end: number };
    mentionInsertion?: number;
    queued: { text: string; attachments: Attachment[]; previewReferences?: PreviewReference[] }[];
    sending: boolean;
    paused: boolean;
  }>>({});

  previewUndo = new Map<string, { text: string; references: PreviewReference[] }[]>();
  composerInsertions = new Map<string, (start: number, end: number, text: string) => void>();
  pendingSends = new Map<string, { id: string; prompt: string; attachments: Attachment[]; previewReferences: PreviewReference[]; selectionVersion: number }>();

  constructor(private readonly ctx: StoreContext) {}

  registerComposerInsertion(key: string, insert: (start: number, end: number, text: string) => void): () => void {
    this.composerInsertions.set(key, insert);
    return () => { if (this.composerInsertions.get(key) === insert) this.composerInsertions.delete(key); };
  }

  editComposerText(key: string, value: string, undo = false, edit?: { start: number; end: number }): void {
    this.composerStates[key] ??= { text: '', attachments: [], queued: [], sending: false, paused: false };
    const draft = this.composerStates[key]!;
    const historyKey = this.ctx.store.threadKey(key);
    const previous = this.previewUndo.get(historyKey);
    if (!previous && !draft.previewReferences?.length) { draft.text = value; return; }
    const history = previous ?? [];
    const restored = undo ? history.findLast(entry => entry.text === value) : undefined;
    history.push({ text: draft.text, references: draft.previewReferences ?? [] });
    if (history.length > 50) history.shift();
    this.previewUndo.set(historyKey, history);
    draft.previewReferences = restored?.references ?? editPreviewMentions(draft.text, value, draft.previewReferences ?? [], edit);
    draft.text = value;
  }

  addPreviewReference(threadId: string, reference: PreviewReference): boolean {
    const s = this.ctx.store;
    if (previewReferencesError([reference])) { s.error = strings.previewComments.failed; return false; }
    this.composerStates[threadId] ??= { text: '', attachments: [], queued: [], sending: false, paused: false };
    const draft = this.composerStates[threadId]!;
    const refs = draft.previewReferences ?? [];
    if (refs.some(item => item.id === reference.id)) return true;
    const inserted = insertPreviewMention(draft.text, refs, reference, draft.selection?.start, draft.selection?.end);
    if (inserted.references.length > PREVIEW_REFERENCES_PER_TURN) { s.error = strings.previewComments.tooMany; return false; }
    const historyKey = s.threadKey(threadId);
    const history = this.previewUndo.get(historyKey) ?? [];
    history.push({ text: draft.text, references: refs });
    if (history.length > 50) history.shift();
    this.previewUndo.set(historyKey, history);
    const start = Math.min(draft.text.length, draft.selection?.start ?? draft.text.length);
    const end = Math.min(draft.text.length, draft.selection?.end ?? draft.text.length);
    this.composerInsertions.get(threadId)?.(start, end, inserted.text.slice(start, inserted.text.length - draft.text.length + end));
    draft.text = inserted.text;
    draft.previewReferences = inserted.references;
    draft.selection = { start: inserted.caret, end: inserted.caret };
    draft.mentionInsertion = (draft.mentionInsertion ?? 0) + 1;
    return true;
  }

  async revealPreviewReference(threadId: string, reference: PreviewReference): Promise<void> {
    try { await showPreviewReference(this.ctx.store, threadId, reference); }
    catch (error) { this.ctx.fail(error); }
  }

  /** Add reviewed context to this machine's unsent draft without queuing a turn. */
  appendComposerText(threadId: string, text: string): void {
    if (!text.trim()) return;
    this.composerStates[threadId] ??= {
      text: '', attachments: [], queued: [], sending: false, paused: false
    };
    const draft = this.composerStates[threadId]!;
    draft.text = draft.text ? `${draft.text}\n\n${text}` : text;
  }

  async submit(prompt: string, choice: Choice, attachments: Attachment[] = [], previewReferences: PreviewReference[] = []): Promise<boolean> {
    const s = this.ctx.store;
    if ((prompt.trim().length === 0 && attachments.length === 0 && previewReferences.length === 0) || s.connection !== 'ready') return false;
    try {
      if (activityCommand(prompt) && previewReferences.length) throw new Error(strings.previewComments.activityUnsupported);
      if (activityCommand(prompt) && attachments.length) throw new Error(strings.activity.noAttachments);
    } catch (error) { this.ctx.fail(error); return false; }
    if (s.draft && !s.openThread) {
      const draft = s.draft;
      const selection = s.draftChoice;
      const prepared = await s.prepareDraftChoice(choice);
      if (!prepared || s.draft !== draft || s.draftChoice !== selection || s.openThread) return false;
      choice = prepared;
    }
    s.remember(choice);
    if (s.openThread) {
      return s.send(prompt, s.openThread.id, attachments, previewReferences);
    }
    const draft = s.draft;
    if (!draft) return false;
    const projectId = draft.projectId ?? (await this.ctx.projects.ensureDrafts());
    if (projectId === null || s.draft !== draft) return false;
    const composer = this.composerStates[DRAFT_STASH_KEY];
    const created = await s.createThread({
      projectId,
      providerId: choice.providerId,
      accountId: choice.accountId,
      permissionMode: choice.permissionMode,
      title: titleFrom(prompt) || undefined,
      effort: choice.effort,
      speed: choice.speed ?? null,
      ...(choice.model ? { model: choice.model } : {}),
      ...(draft.worktree ? { worktree: {} } : {})
    });
    if (!created) return false;
    if (composer) {
      this.composerStates[created.id] = composer;
      delete this.composerStates[DRAFT_STASH_KEY];
    }
    return s.send(prompt, created.id, attachments, previewReferences);
  }

  /**
   * Ctrl+Enter: the same send, then a fresh draft in the same project. The
   * choice is what `submit` already remembered, so the draft's composer opens
   * on the provider, account, model, effort and mode the prompt just went out
   * with. The draft waits for the send, because creating a thread from a draft
   * opens it and would otherwise take the new draft's place.
   */
  async submitAndDraft(
    prompt: string,
    choice: Choice,
    attachments: Attachment[] = [],
    previewReferences: PreviewReference[] = []
  ): Promise<boolean> {
    const s = this.ctx.store;
    const projectId = s.openThread?.projectId ?? s.draft?.projectId;
    const threadId = s.openThread?.id;
    if (!(await s.submit(prompt, choice, attachments, previewReferences))) return false;
    if (projectId !== undefined && (threadId === undefined || s.openThread?.id === threadId)) {
      // Null names the drafts, which the send has made by now.
      s.startDraft(projectId);
      s.draftChoice = { ...choice };
    }
    return true;
  }

  async send(
    prompt: string,
    threadId = this.ctx.store.openThread?.id,
    attachments: Attachment[] = [],
    previewReferences: PreviewReference[] = []
  ): Promise<boolean> {
    const s = this.ctx.store;
    const connection = this.ctx.connection;
    const client = this.ctx.client;
    if (!client || !threadId || s.connection !== 'ready') return false;
    if (prompt.trim().length === 0 && attachments.length === 0 && previewReferences.length === 0) return false;
    try {
      // Reconnect snapshots must land before a new stream starts mutating the thread.
      await connection.reloading?.promise;
      if (this.ctx.client !== client || s.connection !== 'ready') return false;
      const activity = activityCommand(prompt);
      if (activity) {
        if (previewReferences.length) throw new Error(strings.previewComments.activityUnsupported);
        if (attachments.length) throw new Error(strings.activity.noAttachments);
        const accepted = await client.call('threads.activity.set', { threadId, ...activity }).catch((error: unknown) => {
          if (error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound) {
            throw new Error(strings.errors.activityUnsupported.replace('{machine}', s.core?.hostname ?? strings.app.name));
          }
          throw error;
        });
        if (s.openThread?.id === threadId) s.openThread.activity = accepted;
        return true;
      }
      const thread = s.openThread?.id === threadId ? s.openThread : s.threads.find(thread => thread.id === threadId);
      if (thread) {
        const current: Choice = { providerId: thread.providerId, accountId: thread.accountId, model: thread.model,
          effort: thread.effort, permissionMode: thread.permissionMode, speed: thread.speed ?? null };
        const target = s.composerChoice(current);
        if (target.model !== current.model) {
          const revision = thread.selectionVersion ?? 0;
          const prepared = await s.prepareDraftChoice(target);
          if (!prepared || client !== this.ctx.client) return false;
          if (!(await s.update(threadId, { model: prepared.model, effort: prepared.effort, speed: prepared.speed ?? null,
            expectedSelectionVersion: revision }))) return false;
        }
      }
      // The key is left out when there is nothing to carry: a turn with no
      // image sends the params it always sent.
      let pending = this.pendingSends.get(threadId);
      const selectionVersion = (s.openThread?.id === threadId ? s.openThread : s.threads.find((thread) => thread.id === threadId))?.selectionVersion ?? 0;
      if (!pending || pending.selectionVersion !== selectionVersion || pending.prompt !== prompt || JSON.stringify(pending.previewReferences) !== JSON.stringify(previewReferences) || pending.attachments.length !== attachments.length || pending.attachments.some((a, i) => a.kind !== attachments[i]?.kind || a.data !== attachments[i]?.data || a.mimeType !== attachments[i]?.mimeType || a.name !== attachments[i]?.name)) {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        pending = { id: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''), prompt, attachments: [...attachments], previewReferences: JSON.parse(JSON.stringify(previewReferences)) as PreviewReference[], selectionVersion };
        this.pendingSends.set(threadId, pending);
      }
      const sent = pending;
      const start = () => client.call('turns.start', { threadId, prompt, clientRequestId: sent.id, expectedSelectionVersion: selectionVersion,
        ...(attachments.length > 0 ? { attachments } : {}), ...(previewReferences.length > 0 ? { previewReferences } : {}) });
      // A socket lost under the call loses its answer, maybe not the turn: the same request id asks once more, and the core answers with the turn it took.
      await start().catch(async (error: unknown) => {
        if (!wasDropped(error) || !(await readyAgain(client))) throw error;
        await connection.reloading?.promise;
        if (this.ctx.client !== client || this.pendingSends.get(threadId) !== sent) throw error;
        return start();
      });
      this.pendingSends.delete(threadId);
      return true;
    } catch (error) {
      this.ctx.fail(error);
      return false;
    }
  }

  async stop(): Promise<void> {
    const client = this.ctx.client;
    const open = this.ctx.store.openThread;
    if (!client || !open) return;
    try {
      await client.call('turns.stop', { threadId: open.id });
    } catch (error) {
      this.ctx.fail(error);
    }
  }
}
