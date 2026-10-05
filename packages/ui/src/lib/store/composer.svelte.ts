import { RpcErrorCode, PREVIEW_REFERENCES_PER_TURN, previewPrompt, previewReferencesError, type PreviewReference } from '@boite/contracts';
import { untrack } from 'svelte';
import type { Attachment, Message, MessageId, Thread, ThreadSummary, TurnInFlightData } from '@boite/contracts';
import { drainQueue, sendRefusal, sentPrompt } from '../composer-queue';
import { restorePreviewMentions } from '../preview-mentions';
import { activityCommand } from '../activity-command';
import { RpcFailure, readyAgain, wasDropped } from '../client';
import { titleFrom } from '../format';
import { DRAFT_STASH_KEY } from '../prefs';
import { promptText } from '../message-display';
import { lastIndexById } from '../thread-rows';
import type { RewoundMessage } from './threads.svelte';
import { editPreviewMentions, insertPreviewMention } from '../preview-mentions';
import { showPreviewReference } from '../preview-navigation';
import { strings } from '../strings';
import { unresolvedAssetId } from '../draft-attachments';
import type { Choice } from '../store.svelte';
import type { StoreContext } from './context';

/** A prompt waiting behind a running turn, with what it was written with. */
type QueuedPrompt = { text: string; attachments: Attachment[]; previewReferences?: PreviewReference[]; afterBoundary?: string };

/** Marks the id of a prompt shown before the core answered for it. */
const OUTGOING = 'outgoing:';

/** True for a prompt this client shows while its send is out, which the core has not written yet. */
export function isOutgoing(message: Message): boolean {
  return message.id.startsWith(OUTGOING);
}

/** The words of a user message as the bubble shows them, which an early copy and the core's own share. */
function shownText(message: Message): string {
  const part = message.parts.find(part => part.type === 'text');
  return part?.type === 'text' ? promptText(part) : '';
}

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
  private steerRequests = new Map<string, { content: string; id: string }>();

  previewUndo = new Map<string, { text: string; references: PreviewReference[] }[]>();
  composerInsertions = new Map<string, (start: number, end: number, text: string) => void>();
  pendingSends = new Map<string, { id: string; prompt: string; attachments: Attachment[]; previewReferences: PreviewReference[]; selectionVersion: number }>();
  /**
   * Prompts on their way to the core, per thread, shown at the end of its
   * timeline the moment they are sent. Each keeps an `outgoing:` turn id until
   * `turns.start` names the real turn; the core's own message then takes its place.
   */
  outgoing = $state<Record<string, Message[]>>({});
  /** The message an edit or a retry replaces: it and what follows are hidden until the core cuts the thread there. */
  replacing = $state<Record<string, MessageId>>({});
  /** The core's message id for an early copy it replaced, so the timeline does not play its arrival twice. */
  readonly settled = new Map<MessageId, MessageId>();

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
            if (!boundary || state.queued[0]?.afterBoundary === boundary.boundary || this.blocked(threadId) || state.queued.some(entry => activityCommand(entry.text))) continue;
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
    if (!turnId || state.queued.some(entry => activityCommand(entry.text))) return;
    for (const entry of state.queued) entry.afterBoundary = this.inputBoundaries[threadId]?.boundary;
    await drainQueue(s, threadId, state, turnId);
  }

  /** True is provider acceptance, false is safely held input, null is a failed or uncertain send. */
  async steer(prompt: string, threadId: string, turnId: string, attachments: Attachment[], previewReferences: PreviewReference[]): Promise<boolean | null> {
    const s = this.ctx.store;
    const client = this.ctx.client;
    if (!client || s.connection !== 'ready' || this.blocked(threadId)) return false;
    if (attachments.some(unresolvedAssetId)) { s.error = strings.errors.draftAttachment; return null; }
    const selectionVersion = (s.openThread?.id === threadId ? s.openThread : s.threads.find(row => row.id === threadId))?.selectionVersion ?? 0;
    const content = JSON.stringify([turnId, prompt, attachments, previewReferences, selectionVersion]);
    let request = this.steerRequests.get(threadId);
    if (!request || request.content !== content) {
      request = { content, id: crypto.randomUUID() };
      this.steerRequests.set(threadId, request);
    }
    try {
      await this.ctx.connection.reloading?.promise;
      if (this.ctx.client !== client || s.connection !== 'ready') return null;
      const result = await client.call('turns.steer', { threadId, turnId, prompt, attachments, previewReferences,
        clientRequestId: request.id, expectedSelectionVersion: selectionVersion });
      if (this.ctx.client === client && result.accepted) this.steerRequests.delete(threadId);
      return result.accepted;
    } catch (error) {
      if (this.ctx.client !== client) return null;
      // An older core keeps the original end-of-turn queue. An uncertain submission stays paused.
      if (error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound) return false;
      this.ctx.fail(error);
      return null;
    }
  }

  /** A prompt on screen before the core has it, built as the core will build its message. */
  private showOutgoing(threadId: string, prompt: string, attachments: Attachment[], previewReferences: PreviewReference[]): MessageId {
    const id = `${OUTGOING}${crypto.randomUUID()}`;
    const message: Message = {
      id,
      threadId,
      turnId: id,
      role: 'user',
      parts: [
        { type: 'text', text: previewPrompt(prompt, previewReferences), ...(previewReferences.length ? { displayText: prompt, previewReferences: $state.snapshot(previewReferences) } : {}) },
        ...attachments.map((attachment): Message['parts'][number] => attachment.kind === 'file'
          ? { type: 'file', mimeType: attachment.mimeType, data: attachment.data, name: attachment.name }
          : { type: 'image', mimeType: attachment.mimeType, data: attachment.data, alt: attachment.name })
      ],
      state: 'complete',
      createdAt: Date.now()
    };
    this.outgoing[threadId] = [...(this.outgoing[threadId] ?? []), message];
    return id;
  }

  private dropOutgoing(threadId: string, id: MessageId): void {
    const kept = (this.outgoing[threadId] ?? []).filter(message => message.id !== id);
    if (kept.length) this.outgoing[threadId] = kept;
    else delete this.outgoing[threadId];
  }

  /**
   * `turns.start` took the prompt: the early copy waits for the core's message
   * of that turn, unless the thread already holds it or is not on screen to receive it.
   */
  private confirmOutgoing(threadId: string, id: MessageId, turnId: string): void {
    const early = this.outgoing[threadId]?.find(message => message.id === id);
    if (!early) return;
    const held = [...this.ctx.threads.threadSnapshots(threadId)];
    const arrived = held.flatMap(thread => thread.messages).find(message => message.turnId === turnId && message.role === 'user');
    if (arrived) this.markSettled(arrived.id, id);
    if (arrived || held.length === 0) this.dropOutgoing(threadId, id);
    else early.turnId = turnId;
  }

  /**
   * A user message from the core: the early copy of the same turn gives way,
   * or, when the message comes before `turns.start` answered, the oldest
   * unconfirmed copy with the same words.
   */
  settleOutgoing(message: Message): void {
    if (message.role !== 'user') return;
    const early = this.outgoing[message.threadId];
    if (!early) return;
    const match = early.find(item => item.turnId === message.turnId) ??
      early.find(item => item.turnId.startsWith(OUTGOING) && shownText(item) === shownText(message));
    if (!match) return;
    this.markSettled(message.id, match.id);
    this.dropOutgoing(message.threadId, match.id);
  }

  /** Only the latest arrivals matter to the timeline's animation: the oldest pairs go past a hundred. */
  private markSettled(messageId: MessageId, early: MessageId): void {
    this.settled.set(messageId, early);
    if (this.settled.size > 100) this.settled.delete(this.settled.keys().next().value!);
  }

  /**
   * What a thread's timeline shows: its messages, without the one being
   * replaced and those after it, and then the prompts still on their way.
   * With nothing pending this is the thread's own array.
   */
  timelineOf(thread: Thread): Message[] {
    const cut = this.replacing[thread.id];
    const early = this.outgoing[thread.id];
    if (!cut && !early?.length) return thread.messages;
    let messages = thread.messages;
    if (cut) {
      const index = lastIndexById(messages, cut);
      if (index >= 0) messages = messages.slice(0, index);
    }
    if (!early?.length) return messages;
    const turns = new Set(messages.map(message => message.turnId));
    return [...messages, ...early.filter(message => !turns.has(message.turnId))];
  }

  /**
   * A sent message replaced, for an edit or a retry: it and what follows it
   * leave the screen and the new prompt shows in their place at once, then the
   * core rewinds the thread and the prompt goes out. `resend` sends what the
   * rewind gave back instead, the retry of the same prompt. `rewound` is null
   * when the rewind was refused and the thread still holds the message.
   */
  async replace(
    threadId: string,
    messageId: MessageId,
    prompt: string,
    attachments: Attachment[] = [],
    previewReferences: PreviewReference[] = [],
    resend = false
  ): Promise<{ rewound: RewoundMessage | null; sent: boolean }> {
    const shown = this.showOutgoing(threadId, prompt, attachments, previewReferences);
    this.replacing[threadId] = messageId;
    let rewound: RewoundMessage | null = null;
    try {
      rewound = await this.ctx.threads.rewind(messageId, threadId);
    } finally {
      if (this.replacing[threadId] === messageId) delete this.replacing[threadId];
      if (!rewound) this.dropOutgoing(threadId, shown);
    }
    if (!rewound) return { rewound, sent: false };
    const content = resend ? rewound : { prompt, attachments, previewReferences };
    const sent = await this.ctx.store.send(content.prompt, threadId, content.attachments, content.previewReferences, shown);
    if (!sent) this.dropOutgoing(threadId, shown);
    return { rewound, sent };
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
    if (!previous && !draft.previewReferences?.length) { draft.text = value; this.ctx.drafts.persist(); return; }
    const history = previous ?? [];
    const restored = undo ? history.findLast(entry => entry.text === value) : undefined;
    history.push({ text: draft.text, references: draft.previewReferences ?? [] });
    if (history.length > 50) history.shift();
    this.previewUndo.set(historyKey, history);
    draft.previewReferences = restored?.references ?? editPreviewMentions(draft.text, value, draft.previewReferences ?? [], edit);
    draft.text = value;
    this.ctx.drafts.persist();
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
    if (attachments.some(unresolvedAssetId)) { s.error = strings.errors.draftAttachment; return false; }
    if ((prompt.trim().length === 0 && attachments.length === 0 && previewReferences.length === 0) || s.connection !== 'ready') return false;
    const refusal = sendRefusal(prompt, attachments, previewReferences);
    if (refusal) { this.ctx.fail(new Error(refusal)); return false; }
    if (s.openThread) {
      s.remember(choice);
      return s.send(prompt, s.openThread.id, attachments, previewReferences);
    }
    // A new conversation: the prompt shows in the draft while the thread is made.
    const early = activityCommand(prompt) ? undefined : this.showOutgoing(DRAFT_STASH_KEY, prompt, attachments, previewReferences);
    let handed = false;
    try {
      const created = await this.createFromDraft(prompt, choice);
      if (!created) return false;
      if (early) {
        const moved = this.outgoing[DRAFT_STASH_KEY]?.filter(message => message.id === early) ?? [];
        for (const message of moved) message.threadId = created.id;
        if (moved.length) this.outgoing[created.id] = [...(this.outgoing[created.id] ?? []), ...moved];
        this.dropOutgoing(DRAFT_STASH_KEY, early);
      }
      handed = true;
      return await s.send(prompt, created.id, attachments, previewReferences, early);
    } finally {
      if (early && !handed) this.dropOutgoing(DRAFT_STASH_KEY, early);
    }
  }

  /** The thread a draft's first prompt makes, opened, its composer carried over; null when it was not made. */
  private async createFromDraft(prompt: string, choice: Choice): Promise<ThreadSummary | null> {
    const s = this.ctx.store;
    if (s.draft && !s.openThread) {
      const draft = s.draft;
      const selection = s.draftChoice;
      const prepared = await s.prepareDraftChoice(choice);
      if (!prepared || s.draft !== draft || s.draftChoice !== selection || s.openThread) return null;
      choice = prepared;
    }
    s.remember(choice);
    const draft = s.draft;
    if (!draft || s.openThread) return null;
    const projectId = draft.projectId ?? (await this.ctx.projects.ensureDrafts());
    if (projectId === null || s.draft !== draft) return null;
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
    if (!created) return null;
    this.ctx.drafts.forget(draft.projectId);
    if (composer) {
      this.composerStates[created.id] = composer;
      delete this.composerStates[DRAFT_STASH_KEY];
    }
    return created;
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

  /**
   * `shown` names the early copy a caller already put on screen (`replace`);
   * otherwise the prompt shows in the thread now, before any round trip, and
   * leaves again if the core does not take it.
   */
  async send(
    prompt: string,
    threadId = this.ctx.store.openThread?.id,
    attachments: Attachment[] = [],
    previewReferences: PreviewReference[] = [],
    shown?: MessageId
  ): Promise<boolean> {
    const s = this.ctx.store;
    const connection = this.ctx.connection;
    const drop = () => { if (shown && threadId) this.dropOutgoing(threadId, shown); };
    if (attachments.some(unresolvedAssetId)) { s.error = strings.errors.draftAttachment; drop(); return false; }
    const client = this.ctx.client;
    if (!client || !threadId || s.connection !== 'ready') { drop(); return false; }
    if (prompt.trim().length === 0 && attachments.length === 0 && previewReferences.length === 0) { drop(); return false; }
    // An activity command changes the thread's loop or goal and writes no message.
    const early = shown ?? (activityCommand(prompt) ? undefined : this.showOutgoing(threadId, prompt, attachments, previewReferences));
    let turnId: string | null = null;
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
        if (this.ctx.client === client && s.openThread?.id === threadId) s.openThread.activity = accepted;
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
      const turn = await start().catch(async (error: unknown) => {
        if (!wasDropped(error) || !(await readyAgain(client))) throw error;
        await connection.reloading?.promise;
        if (this.ctx.client !== client || this.pendingSends.get(threadId) !== sent) throw error;
        return start();
      });
      if (this.ctx.client === client) {
        this.pendingSends.delete(threadId);
        turnId = turn.id;
      }
      return true;
    } catch (error) {
      // A detached client's answer must not restore input or thread rows into its replacement.
      if (this.ctx.client !== client) return false;
      const early = turnInFlight(error);
      if (early) {
        this.holdBehind(early, { text: prompt, attachments, ...(previewReferences.length ? { previewReferences } : {}) });
        return true;
      }
      this.ctx.fail(error);
      return false;
    } finally {
      // Taken: the copy waits for the core's message. Anything else, a refusal,
      // an activity command or a prompt held behind a turn, takes it off screen.
      if (early && turnId) this.confirmOutgoing(threadId, early, turnId);
      else if (early) this.dropOutgoing(threadId, early);
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
    const open = this.ctx.store.openThread;
    if (!client || !open) return;
    try {
      await client.call('turns.stop', { threadId: open.id });
    } catch (error) {
      this.ctx.fail(error);
    }
  }
}
