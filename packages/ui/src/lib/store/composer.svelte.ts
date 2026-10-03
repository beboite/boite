import { RpcErrorCode, PREVIEW_REFERENCES_PER_TURN, previewReferencesError, type PreviewReference } from '@boite/contracts';
import { untrack } from 'svelte';
import type { Attachment, Message, MessageId, ThreadSummary, TurnInFlightData } from '@boite/contracts';
import { drainQueue, sentPrompt } from '../composer-queue';
import { restorePreviewMentions } from '../preview-mentions';
import { activityCommand, isActivityCommand } from '../activity-command';
import { RpcFailure, readyAgain, wasUnanswered } from '../client';
import { titleFrom } from '../format';
import { DRAFT_STASH_KEY } from '../prefs';
import { editPreviewMentions, insertPreviewMention } from '../preview-mentions';
import { showPreviewReference } from '../preview-navigation';
import { strings } from '../strings';
import { unresolvedAssetId } from '../draft-attachments';
import { secureId } from '../secure-id';
import type { Choice } from '../store.svelte';
import type { StoreContext } from './context';

/**
 * A prompt written while its machine could not be reached: the outbox. It goes
 * out under one request id however often it is sent, so the core takes it once,
 * even when a reload lost the answer to an earlier attempt. It keeps the model,
 * effort and speed it was written with, and the reason the core refused it,
 * which holds it and the prompts behind it until the user sends it again,
 * edits it or removes it.
 */
export type OutboxRequest = { id: string; choice: Choice | null; queuedAt: number; failed?: string };

/** A prompt waiting behind a running turn or for its machine, with what it was written with. */
export type QueuedPrompt = { text: string; attachments: Attachment[]; previewReferences?: PreviewReference[]; afterBoundary?: string; request?: OutboxRequest };

/** What became of one outbox prompt: taken, still to send, or refused with the core's reason. */
export type Delivery = 'sent' | 'wait' | { failed: string };

/** The refusal `turns.start` answers while the thread already runs a turn, or null for any other error. */
function turnInFlight(error: unknown): TurnInFlightData | null {
  if (!(error instanceof RpcFailure) || error.code !== RpcErrorCode.Refused) return null;
  const data = error.data as Partial<TurnInFlightData> | null | undefined;
  return data?.reason === 'turn-in-flight' && data.thread ? data as TurnInFlightData : null;
}

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
    queued: QueuedPrompt[];
    sending: boolean;
    paused: boolean;
    /** The sent message this text replaces: sending rewinds the thread to before it first. */
    editing?: MessageId | null;
  }>>({});

  inputBoundaries = $state<Record<string, { turnId: string; boundary: string }>>({});
  /** Only this client's accepted input asks the timeline to reveal a prompt. */
  promptFocus = $state<{ threadId: string; turnId: string; after: string | null } | null>(null);
  private steerRequests = new Map<string, { content: string; id: string; generation: number }>();

  previewUndo = new Map<string, { text: string; references: PreviewReference[] }[]>();
  composerInsertions = new Map<string, (start: number, end: number, text: string) => void>();
  pendingSends = new Map<string, { id: string; prompt: string; attachments: Attachment[]; previewReferences: PreviewReference[]; selectionVersion: number }>();

  constructor(private readonly ctx: StoreContext) {}

  /** Queued input follows its machine and thread even when their composer is off screen. */
  watchQueues(): () => void {
    return $effect.root(() => {
      $effect(() => {
        const s = this.ctx.store;
        if (s.connection !== 'ready') return;
        for (const [threadId, state] of Object.entries(this.composerStates)) {
          // A refused outbox prompt holds the ones behind it: they were written after it.
          if (!state.queued.length || state.sending || state.paused || state.queued[0]!.request?.failed !== undefined) continue;
          const thread = s.openThread?.id === threadId ? s.openThread : s.threads.find(row => row.id === threadId);
          if (!thread || thread.archived || ['queued', 'waiting'].includes(thread.status)) continue;
          if (thread.status === 'running') {
            const boundary = this.inputBoundaries[threadId];
            // An outbox prompt is a turn of its own, started once the running one ends.
            if (!boundary || state.queued[0]!.request || state.queued[0]?.afterBoundary === boundary.boundary || this.blocked(threadId) || isActivityCommand(state.queued[0]!.text)) continue;
            untrack(() => {
              for (const entry of state.queued) entry.afterBoundary = boundary.boundary;
              void drainQueue(s, threadId, state, boundary.turnId);
            });
          } else untrack(() => void drainQueue(s, threadId, state));
        }
      });
    });
  }


  private blocked(threadId: string): boolean {
    const s = this.ctx.store;
    return s.pendingPermissions.some(request => request.threadId === threadId) ||
      s.pendingQuestions.some(request => request.threadId === threadId && !request.async);
  }

  /** Skip the automatic tool-boundary wait, retaining pending approvals and questions. */
  async sendQueuedNow(threadId: string): Promise<void> {
    const s = this.ctx.store;
    const state = this.composerStates[threadId];
    const thread = s.openThread?.id === threadId ? s.openThread : s.threads.find(row => row.id === threadId);
    if (!state || !thread || state.sending || !state.queued.length || this.blocked(threadId) || thread.status === 'waiting' || thread.status === 'queued') return;
    const head = state.queued[0]!.request;
    if (head?.failed !== undefined || (head && thread.status === 'running')) return;
    state.paused = false;
    if (thread.status !== 'running') { await drainQueue(s, threadId, state); return; }
    const turnId = s.openThread?.id === threadId ? s.openThread.turns.findLast(turn => turn.status === 'running')?.id : this.inputBoundaries[threadId]?.turnId;
    if (isActivityCommand(state.queued[0]!.text)) { s.error = strings.composer.queueWaitForEnd; return; }
    if (!turnId) { s.error = strings.composer.queueTurnNotReady; return; }
    const client = this.ctx.client, generation = this.ctx.clientGeneration;
    const first = state.queued[0];
    for (const entry of state.queued) entry.afterBoundary = this.inputBoundaries[threadId]?.boundary;
    await drainQueue(s, threadId, state, turnId);
    if (client && this.ctx.currentClient(client, generation) && this.composerStates[threadId] === state && state.queued[0] === first && !state.paused) s.error = strings.composer.queueNotAccepted;
  }

  /** True is provider acceptance, false is safely held input, null is a failed or uncertain send. */
  async steer(prompt: string, threadId: string, turnId: string, attachments: Attachment[], previewReferences: PreviewReference[]): Promise<boolean | null> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client || s.connection !== 'ready' || this.blocked(threadId)) return false;
    if (attachments.some(unresolvedAssetId)) { s.error = strings.errors.draftAttachment; return null; }
    const selectionVersion = (s.openThread?.id === threadId ? s.openThread : s.threads.find(row => row.id === threadId))?.selectionVersion ?? 0;
    const content = JSON.stringify([turnId, prompt, attachments, previewReferences, selectionVersion]);
    let request = this.steerRequests.get(threadId);
    try {
      if (!request || request.generation !== clientGeneration || request.content !== content) {
        request = { content, id: secureId(), generation: clientGeneration };
        this.steerRequests.set(threadId, request);
      }
      await this.ctx.connection.reloading?.essential;
      if (!this.ctx.currentClient(client, clientGeneration) || s.connection !== 'ready') return null;
      const after = s.openThread?.id === threadId ? s.openThread.messages.findLast(message => message.role === 'user')?.id ?? null : null;
      const result = await client.call('turns.steer', { threadId, turnId, prompt, attachments, previewReferences,
        clientRequestId: request.id, expectedSelectionVersion: selectionVersion });
      if (!result.accepted && !this.ctx.currentClient(client, clientGeneration)) return null;
      if (this.ctx.currentClient(client, clientGeneration) && result.accepted) {
        this.steerRequests.delete(threadId);
        this.promptFocus = { threadId, turnId, after };
      }
      return result.accepted;
    } catch (error) {
      if (!this.ctx.currentClient(client, clientGeneration)) return null;
      // An older core keeps the original end-of-turn queue. An uncertain submission stays paused.
      if (error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound) return false;
      this.ctx.fail(error);
      return null;
    }
  }

  registerComposerInsertion(key: string, insert: (start: number, end: number, text: string) => void): () => void {
    this.composerInsertions.set(key, insert);
    return () => { if (this.composerInsertions.get(key) === insert) this.composerInsertions.delete(key); };
  }

  editComposerText(key: string, value: string, undo = false, edit?: { start: number; end: number }): void {
    this.composerStates[key] ??= { text: '', attachments: [], queued: [], sending: false, paused: false };
    const draft = this.composerStates[key]!;
    const historyKey = this.ctx.store.threadKey(key);
    const previous = this.previewUndo.get(historyKey);
    if (!previous && !draft.previewReferences?.length) { draft.text = value; this.ctx.drafts.persist(key); return; }
    const history = previous ?? [];
    const restored = undo ? history.findLast(entry => entry.text === value) : undefined;
    history.push({ text: draft.text, references: draft.previewReferences ?? [] });
    if (history.length > 50) history.shift();
    this.previewUndo.set(historyKey, history);
    draft.previewReferences = restored?.references ?? editPreviewMentions(draft.text, value, draft.previewReferences ?? [], edit);
    draft.text = value;
    this.ctx.drafts.persist(key);
  }

  /**
   * A sent message back in its thread's box to be edited: its words, pictures,
   * files and page references, marked as the message the next send replaces.
   * Nothing leaves the thread until that send; the box's own draft gives way.
   */
  startEdit(threadId: string, message: Message): void {
    const prompt = sentPrompt(message);
    const restored = restorePreviewMentions(prompt.text, prompt.previewReferences);
    this.composerStates[threadId] ??= { text: '', attachments: [], queued: [], sending: false, paused: false };
    const state = this.composerStates[threadId]!;
    state.text = restored.text;
    state.previewReferences = restored.references;
    state.attachments = prompt.attachments;
    state.selection = { start: restored.text.length, end: restored.text.length };
    state.editing = message.id;
  }

  /**
   * A prompt that already left the thread back in its box as a plain draft:
   * a retry whose resend failed after the rewind took the message away.
   */
  restoreDraft(threadId: string, prompt: string, attachments: Attachment[], previewReferences: PreviewReference[]): void {
    const restored = restorePreviewMentions(prompt, previewReferences);
    this.composerStates[threadId] ??= { text: '', attachments: [], queued: [], sending: false, paused: false };
    const state = this.composerStates[threadId]!;
    state.text = restored.text;
    state.previewReferences = restored.references;
    state.attachments = attachments;
    state.selection = { start: restored.text.length, end: restored.text.length };
    state.editing = null;
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
    const client = this.ctx.client, generation = this.ctx.clientGeneration;
    try { await showPreviewReference(this.ctx.store, threadId, reference); }
    catch (error) { if (client && this.ctx.currentClient(client, generation)) this.ctx.fail(error); }
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
    return (await this.submitOwned(prompt, choice, attachments, previewReferences)) !== null;
  }

  private async submitOwned(prompt: string, choice: Choice, attachments: Attachment[], previewReferences: PreviewReference[]): Promise<{ navigation: number | null } | null> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    const navigation = s.navigationGeneration;
    const owner = () => this.ctx.client === client && this.ctx.clientGeneration === clientGeneration;
    const current = () => owner() && s.navigationGeneration === navigation;
    if (attachments.some(unresolvedAssetId)) { s.error = strings.errors.draftAttachment; return null; }
    if (!client || (prompt.trim().length === 0 && attachments.length === 0 && previewReferences.length === 0) || s.connection !== 'ready') return null;
    attachments = attachments.map(item => ({ ...item }));
    previewReferences = $state.snapshot(previewReferences);
    choice = { ...choice };
    try {
      if (activityCommand(prompt) && previewReferences.length) throw new Error(strings.previewComments.activityUnsupported);
    } catch (error) { this.ctx.fail(error); return null; }
    if (s.draft && !s.openThread) {
      const draft = s.draft;
      const selection = s.draftChoice;
      const prepared = await s.prepareDraftChoice(choice);
      if (!prepared || !current() || s.draft !== draft || s.draftChoice !== selection || s.openThread) return null;
      choice = prepared;
    }
    s.remember(choice);
    if (s.openThread) {
      return await s.send(prompt, s.openThread.id, attachments, previewReferences) ? { navigation } : null;
    }
    const draft = s.draft;
    if (!draft) return null;
    const projectId = draft.projectId ?? (await this.ctx.projects.ensureDrafts());
    if (projectId === null || !current() || s.draft !== draft) return null;
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
    }, { navigate: false });
    if (!created || !owner()) return null;
    const originalDraft = current() && s.draft === draft && !s.openThread;
    if (!s.draft || s.draft.projectId !== draft.projectId || originalDraft) this.ctx.drafts.forget(draft.projectId);
    if (composer) {
      this.composerStates[created.id] = composer;
      if (this.composerStates[DRAFT_STASH_KEY] === composer && (!s.draft || originalDraft)) delete this.composerStates[DRAFT_STASH_KEY];
    }
    let followupNavigation: number | null = null;
    if (originalDraft) {
      const opening = s.open(created.id);
      const openingGeneration = s.navigationGeneration;
      await opening;
      if (owner() && s.navigationGeneration === openingGeneration && this.ctx.threads.openThread?.id === created.id) followupNavigation = openingGeneration;
    }
    if (!owner()) return null;
    return await s.send(prompt, created.id, attachments, previewReferences) ? { navigation: followupNavigation } : null;
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
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    const sent = await this.submitOwned(prompt, choice, attachments, previewReferences);
    if (!sent) return false;
    if (projectId !== undefined && client === this.ctx.client && clientGeneration === this.ctx.clientGeneration && sent.navigation === s.navigationGeneration) {
      // Null names the drafts, which the send has made by now.
      s.startDraft(projectId);
      s.draftChoice = { ...choice };
    }
    return true;
  }

  /**
   * Puts a prompt at the end of its thread's queue. With `outbox` it is one the
   * machine could not take: it gets its request id, or keeps the one an
   * interrupted send already used, and the choice it was written with, and the
   * device's journal writes it at once rather than after the typing pause.
   */
  queuePrompt(threadId: string, entry: QueuedPrompt, outbox?: { choice: Choice | null; id?: string; head?: boolean }): void {
    this.composerStates[threadId] ??= { text: '', attachments: [], queued: [], sending: false, paused: false };
    const state = this.composerStates[threadId]!;
    const queued: QueuedPrompt = outbox
      ? { ...entry, request: { id: outbox.id ?? secureId(), choice: outbox.choice ? { ...outbox.choice } : null, queuedAt: Date.now() } }
      : entry;
    if (outbox?.head) state.queued.unshift(queued); else state.queued.push(queued);
    if (outbox) { this.ctx.drafts.persist(threadId); void this.ctx.drafts.flush(); }
  }

  /** A refused outbox prompt goes again, under the same request id: its content has not changed. */
  retryQueued(threadId: string, at: number): void {
    const state = this.composerStates[threadId];
    const entry = state?.queued[at];
    if (!state || !entry?.request || state.sending) return;
    const { failed: _failed, ...request } = entry.request;
    entry.request = request;
    state.paused = false;
  }

  /** Takes a pending prompt out of the queue, unless it is the one going out right now. */
  removeQueued(threadId: string, at: number): void {
    const state = this.composerStates[threadId];
    if (!state || (state.sending && at === 0)) return;
    state.queued.splice(at, 1);
  }

  /** One outbox prompt through the composer's own send path, under its request id and choice. */
  deliver(threadId: string, entry: QueuedPrompt & { request: OutboxRequest }): Promise<Delivery> {
    return this.start(entry.text, threadId, entry.attachments, entry.previewReferences ?? [], entry.request);
  }

  async send(
    prompt: string,
    threadId = this.ctx.store.openThread?.id,
    attachments: Attachment[] = [],
    previewReferences: PreviewReference[] = []
  ): Promise<boolean> {
    return (await this.start(prompt, threadId, attachments, previewReferences)) === 'sent';
  }

  private async start(prompt: string, threadId: string | undefined, attachments: Attachment[], previewReferences: PreviewReference[], request?: OutboxRequest): Promise<Delivery> {
    const s = this.ctx.store;
    const connection = this.ctx.connection;
    if (attachments.some(unresolvedAssetId)) {
      if (!request) s.error = strings.errors.draftAttachment;
      return { failed: strings.errors.draftAttachment };
    }
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client || !threadId || s.connection !== 'ready') return 'wait';
    // An empty outbox entry has nothing to deliver; an empty prompt typed now is not sent.
    if (prompt.trim().length === 0 && attachments.length === 0 && previewReferences.length === 0) return request ? 'sent' : 'wait';
    // Held outside the try: a send whose machine does not come back joins the outbox with them.
    let sent: { id: string; prompt: string; attachments: Attachment[]; previewReferences: PreviewReference[]; selectionVersion: number } | undefined;
    let target: Choice | null = null;
    const unsettled = (): Delivery => !this.ctx.currentClient(client, clientGeneration) || s.connection !== 'ready' ? 'wait' : { failed: strings.composer.outboxSettings };
    try {
      // Reconnect snapshots must land before a new stream starts mutating the thread.
      await connection.reloading?.essential;
      if (!this.ctx.currentClient(client, clientGeneration) || s.connection !== 'ready') return 'wait';
      const activity = activityCommand(prompt);
      if (activity) {
        if (previewReferences.length) throw new Error(strings.previewComments.activityUnsupported);
        const accepted = await client.call('threads.activity.set', { threadId, ...activity, ...(attachments.length ? { attachments } : {}) }).catch((error: unknown) => {
          if (error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound) {
            throw new Error(strings.errors.activityUnsupported.replace('{machine}', s.core?.hostname ?? strings.app.name));
          }
          throw error;
        });
        if (this.ctx.currentClient(client, clientGeneration) && s.openThread?.id === threadId) s.openThread.activity = accepted;
        return 'sent';
      }
      const thread = s.openThread?.id === threadId ? s.openThread : s.threads.find(thread => thread.id === threadId);
      if (thread) {
        const current: Choice = { providerId: thread.providerId, accountId: thread.accountId, model: thread.model,
          effort: thread.effort, permissionMode: thread.permissionMode, speed: thread.speed ?? null };
        // An outbox prompt goes out on the model, effort and speed it was written
        // with, if the thread moved off them meanwhile; never on another agent.
        const written = request?.choice && request.choice.providerId === current.providerId && request.choice.accountId === current.accountId ? request.choice : null;
        target = written ? { ...current, model: written.model, effort: written.effort, speed: written.speed ?? null } : s.composerChoice(current);
        if (target.model !== current.model || (written && (target.effort !== current.effort || target.speed !== current.speed))) {
          const revision = thread.selectionVersion ?? 0;
          const prepared = await s.prepareDraftChoice(target);
          if (!prepared || !this.ctx.currentClient(client, clientGeneration)) return unsettled();
          if (!(await s.update(threadId, { model: prepared.model, effort: prepared.effort, speed: prepared.speed ?? null,
            expectedSelectionVersion: revision }))) return unsettled();
          if (!this.ctx.currentClient(client, clientGeneration)) return 'wait';
        }
      }
      // The key is left out when there is nothing to carry: a turn with no
      // image sends the params it always sent.
      const selectionVersion = (s.openThread?.id === threadId ? s.openThread : s.threads.find((thread) => thread.id === threadId))?.selectionVersion ?? 0;
      if (request) {
        sent = { id: request.id, prompt, attachments: [...attachments], previewReferences: $state.snapshot(previewReferences), selectionVersion };
      } else {
        let pending = this.pendingSends.get(threadId);
        if (!pending || pending.selectionVersion !== selectionVersion || pending.prompt !== prompt || JSON.stringify(pending.previewReferences) !== JSON.stringify(previewReferences) || pending.attachments.length !== attachments.length || pending.attachments.some((a, i) => a.kind !== attachments[i]?.kind || a.data !== attachments[i]?.data || a.mimeType !== attachments[i]?.mimeType || a.name !== attachments[i]?.name)) {
          pending = { id: secureId(), prompt, attachments: [...attachments], previewReferences: JSON.parse(JSON.stringify(previewReferences)) as PreviewReference[], selectionVersion };
          this.pendingSends.set(threadId, pending);
        }
        sent = pending;
      }
      const ask = sent;
      const start = () => client.call('turns.start', { threadId, prompt, clientRequestId: ask.id, expectedSelectionVersion: selectionVersion,
        ...(attachments.length > 0 ? { attachments } : {}), ...(previewReferences.length > 0 ? { previewReferences } : {}) });
      // A socket lost under the call, or an answer that never came, loses the answer, maybe not the turn:
      // the same request id asks once more, and the core answers with the turn it took.
      const accepted = await start().catch(async (error: unknown) => {
        if (!wasUnanswered(error) || !this.ctx.currentClient(client, clientGeneration) || !(await readyAgain(client)) || !this.ctx.currentClient(client, clientGeneration)) throw error;
        await connection.reloading?.essential;
        if (!this.ctx.currentClient(client, clientGeneration) || (!request && this.pendingSends.get(threadId) !== ask)) throw error;
        return start();
      });
      if (this.ctx.currentClient(client, clientGeneration)) {
        if (!request) this.pendingSends.delete(threadId);
        this.promptFocus = { threadId, turnId: accepted.id, after: null };
      }
      return 'sent';
    } catch (error) {
      // A detached client's answer must not restore input or thread rows into its replacement.
      if (!this.ctx.currentClient(client, clientGeneration)) return 'wait';
      const early = turnInFlight(error);
      if (early) {
        this.markInFlight(early);
        if (request) return 'wait';
        this.composerStates[early.thread.id]!.queued.unshift({ text: prompt, attachments, ...(previewReferences.length ? { previewReferences } : {}) });
        return 'sent';
      }
      // An outbox prompt waits for the machine; only the core's own refusal stops it.
      if (request) return wasUnanswered(error) || s.connection !== 'ready' ? 'wait' : { failed: this.ctx.reason(error) };
      // The machine did not come back in time, or still does not answer: the
      // prompt joins the outbox under the request id it already went out with,
      // so a turn the core took is answered, not started twice. Handing the
      // text back to the box is what made the user send it again.
      if (sent && wasUnanswered(error) && this.pendingSends.get(threadId) === sent) {
        this.pendingSends.delete(threadId);
        this.queuePrompt(threadId, { text: prompt, attachments, ...(previewReferences.length ? { previewReferences } : {}) }, { choice: target, id: sent.id, head: true });
        return 'sent';
      }
      this.ctx.fail(error);
      return { failed: this.ctx.reason(error) };
    }
  }

  /**
   * The core was already running a turn this client had not seen yet: answers
   * held for an asynchronous question going out on their own, or the agent
   * resuming by itself, opened as the previous turn ended. The prompt is not
   * wrong, only early. It goes back at the head of the thread's queue (an
   * outbox prompt never left it), and the row the core sent keeps the composer
   * waiting until that turn is over.
   */
  private markInFlight({ thread }: TurnInFlightData): void {
    const s = this.ctx.store;
    // The core refused because a turn is in flight, even when its row has not
    // moved off idle yet: waiting is what the composer must do.
    const row: ThreadSummary = ['queued', 'running', 'waiting'].includes(thread.status) ? thread : { ...thread, status: 'running' };
    this.ctx.threads.upsertThread(row);
    if (s.openThread?.id === row.id) Object.assign(s.openThread, row);
    this.composerStates[row.id] ??= { text: '', attachments: [], queued: [], sending: false, paused: false };
  }

  async stop(): Promise<void> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    const open = this.ctx.store.openThread;
    if (!client || !open) return;
    try {
      await client.call('turns.stop', { threadId: open.id });
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
    }
  }
}
