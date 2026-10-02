import { RpcErrorCode, PREVIEW_REFERENCES_PER_TURN, previewReferencesError, type PreviewReference } from '@boite/contracts';
import { untrack } from 'svelte';
import type { Attachment, Message, MessageId, ThreadSummary, TurnInFlightData } from '@boite/contracts';
import { drainQueue, sentPrompt } from '../composer-queue';
import { restorePreviewMentions } from '../preview-mentions';
import { activityCommand, isActivityCommand } from '../activity-command';
import { RpcFailure, readyAgain, wasDropped } from '../client';
import { titleFrom } from '../format';
import { DRAFT_STASH_KEY } from '../prefs';
import { editPreviewMentions, insertPreviewMention } from '../preview-mentions';
import { showPreviewReference } from '../preview-navigation';
import { strings } from '../strings';
import { unresolvedAssetId } from '../draft-attachments';
import { secureId } from '../secure-id';
import type { Choice } from '../store.svelte';
import type { StoreContext } from './context';

/** A prompt waiting behind a running turn, with what it was written with. */
type QueuedPrompt = { text: string; attachments: Attachment[]; previewReferences?: PreviewReference[]; afterBoundary?: string };

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
          if (!state.queued.length || state.sending || state.paused) continue;
          const thread = s.openThread?.id === threadId ? s.openThread : s.threads.find(row => row.id === threadId);
          if (!thread || thread.archived || ['queued', 'waiting'].includes(thread.status)) continue;
          if (thread.status === 'running') {
            const boundary = this.inputBoundaries[threadId];
            if (!boundary || state.queued[0]?.afterBoundary === boundary.boundary || this.blocked(threadId) || isActivityCommand(state.queued[0]!.text)) continue;
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
      if (activityCommand(prompt) && attachments.length) throw new Error(strings.activity.noAttachments);
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

  async send(
    prompt: string,
    threadId = this.ctx.store.openThread?.id,
    attachments: Attachment[] = [],
    previewReferences: PreviewReference[] = []
  ): Promise<boolean> {
    const s = this.ctx.store;
    const connection = this.ctx.connection;
    if (attachments.some(unresolvedAssetId)) { s.error = strings.errors.draftAttachment; return false; }
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client || !threadId || s.connection !== 'ready') return false;
    if (prompt.trim().length === 0 && attachments.length === 0 && previewReferences.length === 0) return false;
    try {
      // Reconnect snapshots must land before a new stream starts mutating the thread.
      await connection.reloading?.essential;
      if (!this.ctx.currentClient(client, clientGeneration) || s.connection !== 'ready') return false;
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
        if (this.ctx.currentClient(client, clientGeneration) && s.openThread?.id === threadId) s.openThread.activity = accepted;
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
          if (!prepared || !this.ctx.currentClient(client, clientGeneration)) return false;
          if (!(await s.update(threadId, { model: prepared.model, effort: prepared.effort, speed: prepared.speed ?? null,
            expectedSelectionVersion: revision }))) return false;
          if (!this.ctx.currentClient(client, clientGeneration)) return false;
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
      const accepted = await start().catch(async (error: unknown) => {
        if (!wasDropped(error) || !this.ctx.currentClient(client, clientGeneration) || !(await readyAgain(client)) || !this.ctx.currentClient(client, clientGeneration)) throw error;
        await connection.reloading?.essential;
        if (!this.ctx.currentClient(client, clientGeneration) || this.pendingSends.get(threadId) !== sent) throw error;
        return start();
      });
      if (this.ctx.currentClient(client, clientGeneration)) {
        this.pendingSends.delete(threadId);
        this.promptFocus = { threadId, turnId: accepted.id, after: null };
      }
      return true;
    } catch (error) {
      // A detached client's answer must not restore input or thread rows into its replacement.
      if (!this.ctx.currentClient(client, clientGeneration)) return false;
      const early = turnInFlight(error);
      if (early) {
        this.holdBehind(early, { text: prompt, attachments, ...(previewReferences.length ? { previewReferences } : {}) });
        return true;
      }
      this.ctx.fail(error);
      return false;
    }
  }

  /**
   * The core was already running a turn this client had not seen yet: answers
   * held for an asynchronous question going out on their own, or the agent
   * resuming by itself, opened as the previous turn ended. The prompt is not
   * wrong, only early. It goes back at the head of the thread's queue, and the
   * row the core sent keeps the composer waiting until that turn is over.
   */
  private holdBehind({ thread }: TurnInFlightData, entry: QueuedPrompt): void {
    const s = this.ctx.store;
    // The core refused because a turn is in flight, even when its row has not
    // moved off idle yet: waiting is what the composer must do.
    const row: ThreadSummary = ['queued', 'running', 'waiting'].includes(thread.status) ? thread : { ...thread, status: 'running' };
    this.ctx.threads.upsertThread(row);
    if (s.openThread?.id === row.id) Object.assign(s.openThread, row);
    this.composerStates[row.id] ??= { text: '', attachments: [], queued: [], sending: false, paused: false };
    this.composerStates[row.id]!.queued.unshift(entry);
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
