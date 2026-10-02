import type {
  Message,
  MessageId,
  PermissionMode,
  ProjectId,
  ProviderId,
  Thread,
  ThreadId,
  ThreadRewind,
  ThreadSummary
} from '@boite/contracts';
import { readingCacheBytes, READING_CACHE_BYTES } from '../reading-cache';
import { INITIAL_MESSAGE_PAGE, MESSAGE_PAGE_MAX, previewToolOutputs } from '@boite/contracts';
import { forgetArchivedThread } from '../archive-history';
import { rightPanel } from '../right-panel.svelte';
import { lastIndexById, mergeResumed, patchRow, reconcileThread, resumeRequest, threadsByProject } from '../thread-rows';
import type { StoreContext } from './context';
import { RpcErrorCode } from '@boite/contracts';
import { RpcFailure } from '../client';
import { strings } from '../strings';

/** What a rewind hands back to the composer: the removed message's content, and how the agent forgets it. */
export type RewoundMessage = Omit<ThreadRewind, 'thread'>;

/** The row part of a thread, without what only an open thread carries. */
function summaryOf(thread: Thread): ThreadSummary {
  const { memoryEvents: _memoryEvents, messages: _messages, turns: _turns, commands: _commands, background: _background, activity: _activity, messagesBefore: _before, messagesFrom: _from, ...summary } = thread;
  return summary;
}

/** The thread list, the open thread and its subscription, and what one thread's lifecycle asks of the core. */
export class Threads {
  threads = $state<ThreadSummary[]>([]);
  /**
   * The open thread holds the window that is loaded, not the whole history:
   * `threads.get` gives the last page and `loadOlder` prepends what is above it.
   */
  openThread = $state<Thread | null>(null);
  /** True while a page of older messages is in flight, so the timeline can say so. */
  loadingOlder = $state(false);
  loadingThreadId = $state<ThreadId | null>(null);
  /** The threads a `threads.retitle` is out for: their menu item waits. */
  retitling = $state<ThreadId[]>([]);
  readonly readingPositions = new Map<string, { top: number; pinned: boolean; heights: Map<string, number>; anchor?: { id: string; offset: number }; height?: number; reservePrompt?: string | null; followPrompt?: string | null }>();
  readingThreads = new Map<string, Thread>();
  subscribedThreadId: ThreadId | null = null;
  /** The number of the newest `open()`, so an older one writes nothing. */
  openGeneration = 0;
  /** What that newest run is opening, so an older one knows what to give back. */
  #openTarget: ThreadId | null = null;
  /** Refreshing this visit keeps disclosures; leaving it invalidates their pending fetches. */
  #toolOutputVisit = 0;

  constructor(private readonly ctx: StoreContext) {}

  rememberReadingThread(): void {
    const thread = this.openThread;
    if (!thread || (this.loadingThreadId === thread.id && thread.messages.length === 0)) return;
    // Keep more small visits within the same 16 MiB budget. An expanded tool
    // gives its full output back to the core before it enters this cache.
    this.readingThreads.delete(thread.id);
    const messages = previewToolOutputs(thread.messages);
    const snapshot = messages.every((message, index) => message === thread.messages[index]) ? thread : { ...thread, messages };
    const bytes = readingCacheBytes(messages);
    if (bytes <= READING_CACHE_BYTES) this.readingThreads.set(thread.id, snapshot);
    let total = [...this.readingThreads.values()].reduce((sum, held) => sum + readingCacheBytes(held.messages), 0);
    while (this.readingThreads.size > 16 || total > 4 * READING_CACHE_BYTES) {
      const oldest = this.readingThreads.keys().next().value!;
      total -= readingCacheBytes(this.readingThreads.get(oldest)!.messages);
      this.readingThreads.delete(oldest);
    }
  }

  #unreadCount = $derived(this.threads.filter((t) => t.unread).length);
  get unreadCount(): number {
    return this.#unreadCount;
  }

  get busy(): boolean {
    const status = this.openThread?.status;
    return status === 'running' || status === 'queued' || status === 'waiting';
  }

  /** One pass over the rows per change of a project, flag or the list itself; a load tick is none of those. */
  #byProject = $derived(threadsByProject(this.threads));
  threadsOf(projectId: ProjectId): ThreadSummary[] {
    return this.#byProject.get(projectId) ?? [];
  }

  async compact(): Promise<void> {
    const thread = this.openThread;
    if (!thread || !this.ctx.client) return;
    try { await this.ctx.client.call('threads.compact', { threadId: thread.id, expectedSelectionVersion: thread.selectionVersion ?? 0 }); }
    catch (error) { this.ctx.fail(error); }
  }

  /**
   * Edit a sent message: it and everything after it leave the thread, on the
   * core and on screen, and what it held comes back for the composer to fill
   * itself with. The thread must be idle: the caller stops a running turn
   * first, and a refusal is shown like any other and answers null. `threadId`
   * defaults to the open thread.
   */
  async rewind(messageId: MessageId, threadId: ThreadId | undefined = this.openThread?.id): Promise<RewoundMessage | null> {
    const client = this.ctx.client;
    if (!client || !threadId) return null;
    try {
      const { thread, ...rewound } = await client.call('threads.rewind', { threadId, messageId });
      this.applyRewound(thread);
      if (rewound.files?.status === 'unavailable') this.ctx.store.error = strings.composer.filesUnavailable;
      return rewound;
    } catch (error) {
      this.ctx.fail(error);
      return null;
    }
  }

  /**
   * A new thread holding this one's history up to and including `messageId`,
   * opened once the core made it. `worktree` puts it in a git worktree of its
   * own, as a new thread's worktree switch does. `threadId` defaults to the
   * open thread. Answers null on a refusal, which is shown.
   */
  async fork(messageId: MessageId, options: { worktree?: boolean } = {}, threadId: ThreadId | undefined = this.openThread?.id): Promise<ThreadSummary | null> {
    const client = this.ctx.client;
    if (!client || !threadId) return null;
    try {
      const summary = await client.call('threads.fork', { threadId, messageId, worktree: options.worktree === true });
      this.upsertThread(summary);
      await this.ctx.store.open(summary.id);
      return summary;
    } catch (error) {
      this.ctx.fail(error);
      return null;
    }
  }

  async forkSideQuestion(threadId: ThreadId, requestId: string): Promise<ThreadSummary | null> {
    const client = this.ctx.client;
    if (!client) return null;
    try {
      const summary = await client.call('threads.btw.fork', { threadId, requestId });
      if (this.ctx.client !== client) return summary;
      this.upsertThread(summary);
      if (this.openThread?.id === threadId) await this.ctx.store.open(summary.id);
      return summary;
    } catch (error) {
      if (this.ctx.client === client) this.ctx.fail(error);
      return null;
    }
  }

  /** The thread as `threads.rewind` left it, over every copy this client holds. */
  applyRewound(thread: Thread): void {
    this.upsertThread(summaryOf(thread));
    // A cached visit holds the removed messages: the next open reads the thread again.
    this.readingThreads.delete(thread.id);
    for (const held of this.threadSnapshots(thread.id)) {
      delete held.messagesFrom;
      Object.assign(held, structuredClone(thread));
    }
  }

  /**
   * `message.truncated`: `messageId` and what follows it left the thread,
   * whichever client asked. A copy that holds the message drops it and the
   * rest; one whose window starts after it can vouch for nothing it holds and
   * reads the thread again. A copy that already applied the rewind holds none
   * of it and has nothing to do.
   */
  truncate(threadId: ThreadId, messageId: MessageId): void {
    this.readingThreads.delete(threadId);
    let stale = false;
    for (const thread of this.threadSnapshots(threadId)) {
      const index = lastIndexById(thread.messages, messageId);
      if (index < 0) {
        if (thread.messagesBefore !== null) stale = true;
        continue;
      }
      const gone = new Set(thread.messages.slice(index).map((message) => message.turnId));
      thread.messages.splice(index);
      const kept = new Set(thread.messages.map((message) => message.turnId));
      thread.turns = thread.turns.filter((turn) => kept.has(turn.id) || !gone.has(turn.id));
    }
    if (stale) void this.reload(threadId);
  }

  /** The last page of a thread again, over the copies held, when what they hold cannot be patched. */
  async reload(threadId: ThreadId): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      const fresh = await client.call('threads.get', { threadId });
      for (const held of this.threadSnapshots(threadId)) {
        held.messages = fresh.messages;
        held.turns = fresh.turns;
        held.messagesBefore = fresh.messagesBefore;
      }
    } catch (error) {
      this.ctx.fail(error);
    }
  }

  /**
   * Two clicks inside one round trip are one thread: the newest run owns the
   * screen and the subscription, and an older one writes nothing, not even
   * `subscribedThreadId`. The order is subscribe then unsubscribe, so a
   * refused subscribe leaves the thread on screen with the socket it had
   * rather than with none at all.
   */
  async open(threadId: ThreadId, navigate = true): Promise<void> {
    const s = this.ctx.store;
    const { delegation } = this.ctx;
    const client = this.ctx.client;
    if (!client) return;
    const generation = ++this.openGeneration;
    this.loadingOlder = false;
    this.#openTarget = threadId;
    if (s.connection !== 'ready') { this.loadingThreadId = null; this.#openOffline(threadId, navigate); return; }
    const newest = (): boolean => this.openGeneration === generation && this.ctx.client === client;
    const previousThread = this.openThread;
    const held = this.openThread?.id === threadId ? this.openThread : this.readingThreads.get(threadId);
    const deselect = this.openThread?.id !== threadId && s.delegationSelectedAgentId && s.delegationSelectedAgentId !== threadId;
    // Paint a recent visit in this task. Its revalidation and subscription can
    // take a whole network round trip without holding the reader's text back.
    const row = this.threads.find(thread => thread.id === threadId);
    if (held) this.#show(Object.assign(held, row), navigate);
    else if (row) this.#show({ ...row, messages: [], turns: [], commands: [], messagesBefore: null }, navigate);
    this.loadingThreadId = held ? null : threadId;
    const deselected = deselect ? s.selectDelegatedAgent(null) : Promise.resolve();
    let loaded = false;
    try {
      const previous = this.subscribedThreadId;
      // Everything this open needs leaves in one burst, in the order the core
      // must run it: on a 150 ms link, five calls awaited one after the other
      // were three quarters of a second before the last card was right, and the
      // messages waited behind a subscribe and an unsubscribe they do not need.
      const subscribed = client.call('threads.subscribe', { threadId });
      // A thread already in hand, open or among the recent ones, asks only for
      // what it cannot vouch for: a reconnect on a long conversation used to
      // download its last 120 messages again for the two that were new.
      const fetched = client.call('threads.get', { ...resumeRequest(threadId, held), limit: held ? MESSAGE_PAGE_MAX : INITIAL_MESSAGE_PAGE, compactTools: true });
      const permissionsAsked = client.call('permissions.list', { threadId });
      const questionsAsked = client.call('questions.list', { threadId });
      // A run that a newer click overtakes returns early and never awaits these.
      for (const asked of [fetched, permissionsAsked, questionsAsked]) asked.catch(() => undefined);
      await subscribed;
      if (!newest()) {
        // A newer click took over while this one was in flight. Its own thread
        // is the one the socket keeps, so this subscription goes back.
        if (this.#openTarget !== threadId) {
          await client.call('threads.unsubscribe', { threadId }).catch(() => undefined);
        }
        return;
      }
      this.subscribedThreadId = threadId;
      // A thread already left that the core will not let go of costs a few
      // events, not the open of this one.
      const unsubscribed: Promise<unknown> = previous && previous !== threadId && previous !== delegation.delegationSubscribedThreadId
        ? client.call('threads.unsubscribe', { threadId: previous }).catch(() => undefined)
        : Promise.resolve();
      const thread = await fetched;
      if (!newest()) return;
      const cached = held ?? this.readingThreads.get(threadId);
      const freshIds = new Set(thread.messages.map(m => m.id));
      if (thread.messagesFrom !== undefined && held) mergeResumed(held, thread);
      else if (cached && cached.messages.some(m => freshIds.has(m.id))) {
        // The fresh tail is authoritative, including a rewind missed while away.
        // Keep only the loaded prefix before its first overlapping message.
        const overlap = cached.messages.findIndex(message => freshIds.has(message.id));
        thread.messages = [...cached.messages.slice(0, overlap), ...thread.messages];
        const turnIds = new Set(thread.turns.map(turn => turn.id));
        thread.turns = [...cached.turns.filter(turn => !turnIds.has(turn.id)), ...thread.turns];
        thread.messagesBefore = cached.messagesBefore;
      } else {
        this.readingThreads.delete(threadId);
        this.readingPositions.delete(threadId);
      }
      this.#show(held ? reconcileThread(held, thread) : thread, navigate, true);
      loaded = true;
      this.loadingThreadId = null;
      // The thread may already be waiting on a request this page never saw,
      // and may have had one settled where this client could not hear it.
      const permissions = await permissionsAsked;
      const questions = await questionsAsked;
      await unsubscribed;
      if (!newest()) return;
      this.ctx.requests.mergePermissions(permissions, threadId);
      this.ctx.requests.mergeQuestions(questions, threadId);
      if (thread.unread) {
        await client.call('threads.markRead', { threadId });
        if (!newest()) return;
        thread.unread = false;
        this.threads = this.threads.map((t) => (t.id === threadId ? { ...t, unread: false } : t));
      }
    } catch (error) {
      if (newest()) {
        if (!loaded && error instanceof RpcFailure && (error.code === RpcErrorCode.NotFound || error.code === RpcErrorCode.Refused)) {
          if (previousThread && previousThread.id !== threadId) this.#show(previousThread, navigate);
          else this.openThread = null;
          // Rollback can remember the rejected target: discard it afterwards.
          this.readingThreads.delete(threadId);
          this.readingPositions.delete(threadId);
        }
        this.ctx.fail(error);
      }
    } finally {
      if (newest()) this.loadingThreadId = null;
      await deselected;
    }
  }

  /** Select the history synchronously; network work never owns navigation. */
  #show(thread: Thread, navigate: boolean, refreshTrace = false): void {
    const s = this.ctx.store;
    const { delegation, workbench } = this.ctx;
    if (this.openThread?.id !== thread.id) {
      this.#toolOutputVisit++;
      this.rememberReadingThread();
      this.ctx.drafts.park();
      s.draft = null;
      this.loadingOlder = false;
      delegation.delegationEpoch++;
      delegation.delegationConfigureEpoch++;
      s.delegation = null;
      s.delegationLoading = false;
      s.delegationSaving = false;
      s.delegationError = null;
      this.leaveArchived(thread.id);
      this.ctx.requests.keepRequestsOf(thread.id);
    }
    this.openThread = thread;
    if (navigate) {
      s.page = 'chat';
      s.sidebarOpen = false;
      if (thread.projectId) this.ctx.projects.rememberProject(thread.projectId);
    }
    if (workbench.tracedThreadId !== thread.id) s.trace = [];
    else if (refreshTrace && s.traceWatched) void s.refreshTrace();
    workbench.tracedThreadId = thread.id;
  }

  /**
   * A machine that dropped keeps its rows, and one of them still opens: the
   * timeline this client last read, or the bare row, so a prompt can wait in
   * the composer's queue until the machine is back. Nothing is asked of the
   * core; the reconnect's boot reopens the thread and fetches what it holds.
   */
  #openOffline(threadId: ThreadId, navigate: boolean): void {
    const s = this.ctx.store;
    const row = this.threads.find((t) => t.id === threadId);
    if (this.openThread?.id !== threadId) {
      const held = this.readingThreads.get(threadId);
      if (!row && !held) return;
      this.#toolOutputVisit++;
      this.rememberReadingThread();
      this.ctx.drafts.park();
      s.draft = null;
      this.loadingOlder = false;
      const { delegation } = this.ctx;
      delegation.delegationEpoch++;
      delegation.delegationConfigureEpoch++;
      s.delegation = null;
      s.delegationLoading = false;
      s.delegationSaving = false;
      s.delegationError = null;
      this.leaveArchived(threadId);
      // A bare row has no messages in hand and says so: nothing above it to page in.
      this.openThread = held ? { ...held, ...row } : { ...row!, messages: [], turns: [], commands: [], messagesBefore: null };
      this.ctx.requests.keepRequestsOf(threadId);
    }
    if (navigate) {
      s.page = 'chat';
      s.sidebarOpen = false;
      const projectId = this.openThread?.projectId;
      if (projectId) this.ctx.projects.rememberProject(projectId);
    }
  }

  /** The cursor above the loaded window, null when the first message is already in hand. */
  get messagesBefore(): MessageId | null {
    return this.openThread?.messagesBefore ?? null;
  }

  /**
   * One page of messages older than the window, prepended in place. Nothing
   * happens without a cursor or while a page is already in flight, and a page
   * that lands on a thread the user has left is dropped. Returns how many
   * messages landed, so the caller can put their height back into `scrollTop`.
   */
  async loadOlder(): Promise<number> {
    const client = this.ctx.client;
    const open = this.openThread;
    if (!client || !open) return 0;
    const cursor = open.messagesBefore;
    if (cursor === null || this.loadingOlder) return 0;
    this.loadingOlder = true;
    const generation = this.openGeneration;
    try {
      const page = await client.call('messages.list', { threadId: open.id, before: cursor, compactTools: true });
      const still = this.openThread;
      if (this.ctx.client !== client || generation !== this.openGeneration || !still || still.id !== open.id || still.messagesBefore !== cursor) return 0;
      const known = new Set(still.messages.map((m) => m.id));
      const older = page.messages.filter((m) => !known.has(m.id));
      still.messages.unshift(...older);
      const knownTurns = new Set(still.turns.map((turn) => turn.id));
      // Older turns go first, as in the journal: the last one is the latest turn.
      still.turns.unshift(...(page.turns ?? []).filter((turn) => !knownTurns.has(turn.id)));
      still.messagesBefore = page.before;
      return older.length;
    } catch (error) {
      if (this.ctx.client === client && generation === this.openGeneration) this.ctx.fail(error);
      return 0;
    } finally {
      if (this.ctx.client === client && generation === this.openGeneration) this.loadingOlder = false;
    }
  }

  readonly #toolOutputs = new Map<string, { client: NonNullable<StoreContext['client']>; generation: number; promise: Promise<void> }>();
  /** Hydrate only a disclosure the reader opened, shared by duplicate requests. */
  loadToolOutput(threadId: ThreadId, messageId: MessageId, toolId: string): Promise<void> {
    const key = JSON.stringify([threadId, messageId, toolId]);
    const client = this.ctx.client;
    if (!client) return Promise.reject(new Error(strings.connection.unavailable));
    const generation = this.#toolOutputVisit;
    const held = this.#toolOutputs.get(key);
    if (held?.client === client && held.generation === generation) return held.promise;
    const loading = client.call('messages.toolOutput', { threadId, messageId, toolId }).catch(async error => {
      if (!(error instanceof RpcFailure) || error.code !== RpcErrorCode.MethodNotFound) throw error;
      if (this.ctx.client !== client || generation !== this.#toolOutputVisit) return { output: null };
      // Older connected cores return full parts through their existing history
      // methods. Prefer one message before its known successor, else walk back
      // from a resumed tail if new work has overtaken the cached last message.
      const thread = [...this.threadSnapshots(threadId)].find(held => held.messages.some(message => message.id === messageId));
      const next = thread?.messages[lastIndexById(thread.messages, messageId) + 1]?.id;
      const page = next
        ? await client.call('messages.list', { threadId, before: next, limit: 1 })
        : await client.call('threads.get', { threadId, after: messageId });
      let message = page.messages.find(message => message.id === messageId);
      let before = 'before' in page ? page.before : page.messagesBefore;
      while (!message && before && this.ctx.client === client && generation === this.#toolOutputVisit) {
        const older = await client.call('messages.list', { threadId, before, limit: MESSAGE_PAGE_MAX });
        message = older.messages.find(message => message.id === messageId);
        if (older.before === before) break;
        before = older.before;
      }
      const part = message?.parts.find(part => part.type === 'tool' && part.toolId === toolId);
      if (part?.type !== 'tool') throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `tool ${toolId} is not a tool of message ${messageId}` });
      return { output: part.output };
    }).then(({ output }) => {
      if (this.ctx.client !== client || generation !== this.#toolOutputVisit) return;
      for (const message of this.messages(threadId, messageId)) {
        for (const part of message.parts) {
          if (part.type !== 'tool' || part.toolId !== toolId || !part.outputDeferred) continue;
          part.output = output;
          delete part.outputDeferred;
        }
      }
    }).finally(() => { if (this.#toolOutputs.get(key)?.promise === loading) this.#toolOutputs.delete(key); });
    this.#toolOutputs.set(key, { client, generation, promise: loading });
    return loading;
  }

  async createThread(input: {
    projectId: ProjectId;
    providerId: ProviderId;
    accountId: string;
    title?: string;
    permissionMode?: PermissionMode;
    model?: string;
    effort?: string | null;
    speed?: string | null;
    worktree?: { branch?: string };
  }): Promise<ThreadSummary | null> {
    const client = this.ctx.client;
    if (!client) return null;
    try {
      const summary = await client.call('threads.create', input);
      this.upsertThread(summary);
      await this.ctx.store.open(summary.id);
      return summary;
    } catch (error) {
      this.ctx.fail(error);
      return null;
    }
  }

  async update(
    threadId: ThreadId,
    patch: { title?: string; accountId?: string; model?: string | null; effort?: string | null; speed?: string | null; permissionMode?: PermissionMode; expectedSelectionVersion?: number }
  ): Promise<boolean> {
    const client = this.ctx.client;
    if (!client) return false;
    try {
      const summary = await client.call('threads.update', { threadId, ...patch });
      this.upsertThread(summary);
      const open = this.openThread;
      if (open && open.id === threadId) Object.assign(open, summary);
      return true;
    } catch (error) {
      this.ctx.fail(error);
      return false;
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const open = this.openThread;
    if (!open) return;
    await this.ctx.store.update(open.id, { permissionMode: mode });
  }

  async rename(threadId: ThreadId, title: string): Promise<void> {
    const clean = title.trim();
    if (clean.length === 0) return;
    await this.ctx.store.update(threadId, { title: clean });
  }

  /** The agent's own title for the thread, asked again. The menu item is out while it runs. */
  async retitle(threadId: ThreadId): Promise<void> {
    const client = this.ctx.client;
    if (!client || this.retitling.includes(threadId)) return;
    this.retitling = [...this.retitling, threadId];
    try {
      const summary = await client.call('threads.retitle', { threadId });
      this.upsertThread(summary);
      const open = this.openThread;
      if (open && open.id === threadId) Object.assign(open, summary);
    } catch (error) {
      this.ctx.fail(error);
    } finally {
      this.retitling = this.retitling.filter((id) => id !== threadId);
    }
  }

  async pin(threadId: ThreadId, pinned: boolean): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      const summary = await client.call('threads.pin', { threadId, pinned });
      this.upsertThread(summary);
      const open = this.openThread;
      if (open && open.id === threadId) open.pinned = summary.pinned;
    } catch (error) {
      this.ctx.fail(error);
    }
  }

  /**
   * The thread and its sub-threads into another project. The core answers
   * the row in its new place, or with `pendingMove` while its turn runs, and
   * tells every other client with `thread.updated`; the sidebar moves the row
   * from either.
   */
  async move(threadId: ThreadId, projectId: ProjectId, stopBackground?: boolean): Promise<ThreadSummary | null> {
    return this.moveCall(threadId, (client) => client.call('threads.move', { threadId, projectId, ...(stopBackground === undefined ? {} : { stopBackground }) }));
  }

  /** The move waiting for the turn to end goes; the thread stays where it is. */
  async cancelMove(threadId: ThreadId): Promise<ThreadSummary | null> {
    return this.moveCall(threadId, (client) => client.call('threads.moveCancel', { threadId }));
  }

  private async moveCall(threadId: ThreadId, call: (client: NonNullable<typeof this.ctx.client>) => Promise<ThreadSummary>): Promise<ThreadSummary | null> {
    const client = this.ctx.client;
    if (!client) return null;
    try {
      const summary = await call(client);
      this.upsertThread(summary);
      const open = this.openThread;
      if (open && open.id === threadId) Object.assign(open, summary);
      return summary;
    } catch (error) {
      this.ctx.fail(error);
      return null;
    }
  }

  async archive(threadId: ThreadId): Promise<void> {
    const client = this.ctx.client;
    if (!client) return;
    try {
      await client.call('threads.archive', { threadId, archived: true });
      this.threads = this.threads.filter((t) => t.id !== threadId);
      this.ctx.requests.dropRequestsOf(threadId);
      const wasOpen = this.openThread?.id === threadId;
      if (wasOpen) this.openThread = null;
      this.forgetThread(threadId);
      if (wasOpen) {
        await this.unsubscribe();
        await this.ctx.store.openWhereLeft();
      }
    } catch (error) {
      this.ctx.fail(error);
    }
  }

  async removeThread(threadId: ThreadId): Promise<boolean> {
    const client = this.ctx.client;
    if (!client) return false;
    try {
      await client.call('threads.remove', { threadId });
      await this.removed(threadId);
      return true;
    } catch (error) {
      if (error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound) {
        this.ctx.store.error = strings.sidebar.deleteUnavailable;
      } else this.ctx.fail(error);
      return false;
    }
  }

  async restoreDeletedThread(threadId: ThreadId): Promise<ThreadSummary | null> {
    const client = this.ctx.client;
    if (!client) return null;
    try {
      const summary = await client.call('threads.restore', { threadId });
      this.upsertThread(summary);
      return summary;
    } catch (error) { this.ctx.fail(error); return null; }
  }

  /** Applied to this machine only, for both RPC answers and removal events. */
  async removed(threadId: ThreadId): Promise<void> {
    const s = this.ctx.store;
    this.threads = this.threads.filter(t => t.id !== threadId);
    forgetArchivedThread(s, threadId);
    this.ctx.requests.dropRequestsOf(threadId);
    this.forgetThread(threadId);
    if (this.#openTarget === threadId) { this.openGeneration++; this.#openTarget = null; }
    if (s.delegationThread?.id === threadId) s.delegationThread = null;
    if (this.openThread?.id !== threadId) return;
    this.openThread = null;
    await this.unsubscribe();
    await s.openWhereLeft();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async unsubscribe(): Promise<void> {
    const s = this.ctx.store;
    const delegation = this.ctx.delegation;
    const client = this.ctx.client;
    const previous = this.subscribedThreadId;
    const delegated = delegation.delegationSubscribedThreadId;
    delegation.delegationSelectionEpoch++;
    this.subscribedThreadId = null;
    delegation.delegationSubscribedThreadId = null;
    s.delegationSelectedAgentId = null;
    s.delegationThread = null;
    if (!client || (!previous && !delegated)) return;
    const ids = [...new Set([previous, delegated].filter((id): id is string => id !== null))];
    await Promise.all(ids.map(threadId => client.call('threads.unsubscribe', { threadId }).catch(() => undefined)));
  }

  upsertThread(summary: ThreadSummary): void {
    const row = this.threads.find((t) => t.id === summary.id);
    if (row) patchRow(row, summary);
    else this.threads.push(summary);
  }

  /** What the UI keeps per thread, dropped once the thread is archived or gone: a restored thread starts fresh. */
  forgetThread(threadId: ThreadId): void {
    const s = this.ctx.store;
    const composer = this.ctx.composer;
    delete s.composerStates[threadId];
    composer.previewUndo.delete(s.threadKey(threadId));
    composer.pendingSends.delete(threadId);
    this.readingThreads.delete(threadId);
    this.readingPositions.delete(threadId);
    if (s.terminalShown(threadId)) s.hideTerminal(threadId);
    rightPanel.forget(s.threadKey(threadId));
  }

  /** The open thread, archived from another client, stayed on screen with its panel; leaving it lets that go. */
  leaveArchived(next: ThreadId | null): void {
    const left = this.openThread;
    if (left?.archived && left.id !== next) this.forgetThread(left.id);
  }

  threadSnapshots(threadId: ThreadId): Set<Thread> {
    return new Set([this.openThread, this.ctx.store.delegationThread].filter((thread): thread is Thread => thread?.id === threadId));
  }

  messages(threadId: ThreadId, messageId: string): Set<Message> {
    const messages = new Set<Message>();
    for (const thread of this.threadSnapshots(threadId)) {
      const message = thread.messages[lastIndexById(thread.messages, messageId)];
      if (message) messages.add(message);
    }
    return messages;
  }

  upsertTurn(threadId: ThreadId, turn: Thread['turns'][number]): void {
    for (const thread of this.threadSnapshots(threadId)) {
      const index = lastIndexById(thread.turns, turn.id);
      if (index >= 0) thread.turns[index] = turn;
      else thread.turns.push(turn);
    }
  }
}
