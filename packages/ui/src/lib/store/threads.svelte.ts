import { createWithPreparation, mergeCreationSnapshot } from './thread-creation';
import { messageCopies, RowIndex, threadCopies } from './thread-lookup';
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
import { ReadingCache, readingCacheBytes } from '../reading-cache';
import { INITIAL_MESSAGE_PAGE, INITIAL_PAGE_BYTES, READING_PAGE_BYTES, forTransport } from '@boite/contracts';
import { DeferredParts } from './deferred-parts';
import { askPage, ThreadPreloads } from './thread-preload';
import { lightPage, NewerPages, setMessagesAfter, type ReadingPosition } from './reading-pages.svelte';
export type { ReadingPosition } from './reading-pages.svelte';
import { forgetArchivedThread } from '../archive-history';
import { rightPanel } from '../right-panel.svelte';
import { workingChildren, type WorkingChildren, lastIndexById, mergeResumed, patchFields, patchRow, reconcileThread, threadsByProject } from '../thread-rows';
import type { StoreContext } from './context';
import { RpcErrorCode, threadActive } from '@boite/contracts';
import { RpcFailure, wasDropped } from '../client';
import { wasClosed } from '../rpc-error';
import { strings } from '../strings';
import { experimentOn } from '../experiments.svelte';
import { archiveWhile, keepArchived, pinWhile } from './optimistic';

/** What a rewind hands back to the composer: the removed message's content, and how the agent forgets it. */
export type RewoundMessage = Omit<ThreadRewind, 'thread'>;

/** The row part of a thread, without what only an open thread carries. */
function summaryOf(thread: Thread): ThreadSummary {
  const { memoryEvents: _memoryEvents, messages: _messages, turns: _turns, commands: _commands, background: _background, backgroundHistory: _history, activity: _activity, messagesBefore: _before, messagesAfter: _after, messagesFrom: _from, messagesSync: _sync, messagesUnchanged: _unchanged, messageOffset: _offset, ...summary } = thread;
  return summary;
}

/** The thread list, the open thread and its subscription, and what one thread's lifecycle asks of the core. */
export class Threads {
  threads = $state<ThreadSummary[]>([]);
  #rowIndex = new RowIndex();
  /**
   * The open thread holds the window that is loaded, not the whole history:
   * `threads.get` gives the last page and `loadOlder` prepends what is above it.
   */
  openThread = $state<Thread | null>(null);
  /** True while a page of older messages is in flight, so the timeline can say so. */
  loadingOlder = $state(false);
  loadingThreadId = $state<ThreadId | null>(null);
  /** How much of the loading thread's page arrived, against the core's own total; null until a slice says it. */
  loadingBytes = $state<{ threadId: ThreadId; received: number; total: number } | null>(null);
  /** The pages below a window opened around a reading position. */
  readonly newer: NewerPages;
  readonly preloads: ThreadPreloads;
  /** The threads a `threads.retitle` is out for: their menu item waits. */
  retitling = $state<ThreadId[]>([]);
  /**
   * The message a `threads.rewind` in flight removes, per thread: the timeline
   * hides it and what follows at once instead of after the core restored files.
   */
  rewinding = $state<Record<ThreadId, MessageId>>({});
  readonly readingPositions = new Map<string, ReadingPosition>();
  readonly readingThreads = new ReadingCache();
  subscribedThreadId: ThreadId | null = null;
  /** The newest navigation intent, including drafts, pages and detached clients. */
  openGeneration = 0;
  /** What that newest run is opening, so an older one knows what to give back. */
  #openTarget: ThreadId | null = null;
  #olderGeneration = 0;
  /** The folded parts of this visit's messages, fetched when opened. */
  readonly parts: DeferredParts;

  constructor(private readonly ctx: StoreContext) { this.newer = new NewerPages(ctx); this.preloads = new ThreadPreloads(ctx, this); this.parts = new DeferredParts(ctx, this); }
  get openTarget(): ThreadId | null { return this.#openTarget; }

  async capabilities(threadId: ThreadId) {
    const client = this.ctx.client;
    const generation = this.ctx.clientGeneration;
    if (!client) return null;
    try {
      const capabilities = await client.call('threads.capabilities', { threadId });
      return this.ctx.currentClient(client, generation) ? capabilities : null;
    } catch (error) {
      // Older cores keep their existing action checks until updated.
      if (error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound) return null;
      throw error;
    }
  }

  async recoverTurn(threadId: ThreadId, turnId: string, action: 'resume' | 'discard'): Promise<void> {
    const client = this.ctx.client;
    const generation = this.ctx.clientGeneration;
    if (!client) return;
    try {
      const turn = await client.call('turns.recover', { threadId, turnId, action });
      if (this.ctx.currentClient(client, generation)) this.upsertTurn(threadId, turn);
    } catch (error) {
      if (this.ctx.currentClient(client, generation) && this.openThread?.id === threadId) this.ctx.fail(error);
    }
  }

  /**
   * The ordinary thread the chat last showed: switching from the Agents page
   * back to the thread list comes back to it rather than to the agent's thread.
   */
  lastChatThreadId: ThreadId | null = null;

  /**
   * Where a thread opens: a persistent agent's own thread on the Agents page,
   * beside the agents list, every other one in the chat.
   */
  pageOf(thread: Pick<ThreadSummary, 'agentSessionId'>): 'chat' | 'agents' {
    return thread.agentSessionId && experimentOn('resident-agents') ? 'agents' : 'chat';
  }

  invalidateNavigation(): number {
    this.#openTarget = null;
    this.#olderGeneration++;
    this.loadingOlder = false;
    this.newer.reset();
    this.loadingThreadId = null;
    this.loadingBytes = null;
    return ++this.openGeneration;
  }

  rememberReadingThread(): void {
    const thread = this.openThread;
    if (!thread || (this.loadingThreadId === thread.id && thread.messages.length === 0)) return;
    // Keep more small visits within the same 16 MiB budget. An expanded tool
    // gives its full output back to the core before it enters this cache.
    const messages = forTransport(thread.messages, lightPage(this.ctx));
    const kept = messages.every((message, index) => message === thread.messages[index]) ? thread : { ...thread, messages };
    // The deep proxy on screen weighs several times its data: once the next thread is painted, plain data replaces it.
    this.readingThreads.remember(thread.id, kept, readingCacheBytes(messages), held => $state.snapshot(held) as Thread,
      () => this.openThread?.id !== thread.id && this.preloads.waitingThreadId !== thread.id);
  }

  #unreadCount = $derived(this.threads.filter((t) => t.unread).length);
  get unreadCount(): number {
    return this.#unreadCount;
  }

  get busy(): boolean {
    const status = this.openThread?.status;
    return status !== undefined && threadActive(status);
  }

  /** One pass over the rows per change of a project, flag or the list itself; a load tick is none of those. */
  #byProject = $derived(threadsByProject(this.threads));
  threadsOf(projectId: ProjectId): ThreadSummary[] {
    return this.#byProject.get(projectId) ?? [];
  }

  #workingChildren = $derived(workingChildren(this.threads));
  /** The thread's delegated agents still at work or asking the user; null when none is. */
  subagents(threadId: ThreadId): WorkingChildren | null { return this.#workingChildren.get(threadId) ?? null; }
  /** A move waits on the children at work; one that only asks, its turn over, does not hold it. */
  moveBlocked(threadId: ThreadId): boolean { return (this.#workingChildren.get(threadId)?.count ?? 0) > 0; }

  async compact(): Promise<void> {
    const thread = this.openThread;
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!thread || !client) return;
    try { await client.call('threads.compact', { threadId: thread.id, expectedSelectionVersion: thread.selectionVersion ?? 0 }); }
    catch (error) { if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error); }
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
    const clientGeneration = this.ctx.clientGeneration;
    if (!client || !threadId) return null;
    this.rewinding[threadId] = messageId;
    try {
      const { thread, ...rewound } = await client.call('threads.rewind', { threadId, messageId });
      if (!this.ctx.currentClient(client, clientGeneration)) return null;
      this.applyRewound(thread);
      if (rewound.files?.status === 'unavailable') this.ctx.store.error = rewound.files.busy ? strings.composer.filesBusy : strings.composer.filesUnavailable;
      return rewound;
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
      return null;
    } finally {
      // Refused, the hidden messages come back; taken, the thread no longer holds them.
      if (this.rewinding[threadId] === messageId) delete this.rewinding[threadId];
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
    const clientGeneration = this.ctx.clientGeneration;
    if (!client || !threadId) return null;
    const generation = this.openGeneration;
    try {
      const summary = await client.call('threads.fork', { threadId, messageId, worktree: options.worktree === true });
      if (!this.ctx.currentClient(client, clientGeneration)) return null;
      this.upsertThread(summary);
      if (this.ctx.currentNavigation(client, generation)) await this.ctx.store.open(summary.id);
      return summary;
    } catch (error) {
      if (this.ctx.currentNavigation(client, generation)) this.ctx.fail(error);
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

  async mergeBack(threadId: ThreadId, summary: string, requestId: string) {
    const client = this.ctx.client;
    const generation = this.ctx.clientGeneration;
    if (!client) return null;
    try {
      const receipt = await client.call('threads.mergeBack', { threadId, summary, requestId });
      return this.ctx.currentClient(client, generation) ? receipt : null;
    } catch (error) {
      if (this.ctx.currentClient(client, generation) && this.openThread?.id === threadId) this.ctx.fail(error);
      return null;
    }
  }

  /** The thread as `threads.rewind` left it, over every copy this client holds. */
  applyRewound(thread: Thread): void {
    this.upsertThread(summaryOf(thread)); this.ctx.positions.note(thread.id, thread.messages, thread.messageOffset);
    // A cached visit holds the removed messages: the next open reads the thread again.
    this.readingThreads.delete(thread.id);
    for (const held of this.threadSnapshots(thread.id)) {
      delete held.messagesFrom;
      delete held.messagesSync;
      delete held.messagesAfter;
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
        if (thread.messagesBefore !== null || this.ctx.positions.hasGap(thread)) stale = true;
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
    const clientGeneration = this.ctx.clientGeneration;
    if (!client) return;
    try {
      // The page a first visit reads: what the copies held cannot be patched, so they start over.
      const fresh = this.ctx.positions.noted(threadId, await client.call('threads.get', { threadId, limit: INITIAL_MESSAGE_PAGE, maxBytes: INITIAL_PAGE_BYTES, ...lightPage(this.ctx) }));
      if (!this.ctx.currentClient(client, clientGeneration)) return;
      for (const held of this.threadSnapshots(threadId)) {
        held.messages = fresh.messages;
        held.turns = fresh.turns;
        held.messagesBefore = fresh.messagesBefore;
        setMessagesAfter(held, fresh.messagesAfter);
      }
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
    }
  }

  /**
   * Two clicks inside one round trip are one thread: the newest run owns the
   * screen and the subscription, and an older one writes nothing, not even
   * `subscribedThreadId`. The order is subscribe then unsubscribe, so a
   * refused subscribe leaves the thread on screen with the socket it had
   * rather than with none at all.
   */
  async open(threadId: ThreadId, navigate = true, options: { requests?: boolean; liveCreation?: boolean } = {}): Promise<void> {
    const s = this.ctx.store;
    const { delegation } = this.ctx;
    const client = this.ctx.client;
    if (!client) return;
    const generation = this.invalidateNavigation();
    this.#openTarget = threadId;
    if (s.connection !== 'ready') { this.loadingThreadId = null; this.#openOffline(threadId, navigate); return; }
    const newest = (): boolean => this.ctx.currentNavigation(client, generation);
    const retire = async (): Promise<void> => {
      if (client === this.ctx.client && this.#openTarget === null && this.subscribedThreadId && this.subscribedThreadId !== threadId) {
        await client.call('threads.subscribe', { threadId: this.subscribedThreadId }).catch(() => undefined);
      }
      if (client !== this.ctx.client || (this.subscribedThreadId !== threadId && delegation.delegationSubscribedThreadId !== threadId && (this.#openTarget !== threadId || newest()))) {
        await client.call('threads.unsubscribe', { threadId }).catch(() => undefined);
      }
    };
    const previousThread = this.openThread;
    let held = this.openThread?.id === threadId ? this.openThread : this.readingThreads.get(threadId);
    // A press on this thread already asked for its page (`thread-preload.ts`): the open takes it over.
    const preloaded = this.preloads.claim(threadId, client, held);
    const deselect = this.openThread?.id !== threadId && s.delegationSelectedAgentId && s.delegationSelectedAgentId !== threadId;
    // Paint a recent visit in this task. Its revalidation and subscription can
    // take a whole network round trip without holding the reader's text back.
    const row = this.threads.find(thread => thread.id === threadId);
    if (held) held = this.#showHeld(Object.assign(held, row), navigate);
    else if (row) this.#show({ ...row, messages: [], turns: [], commands: [], messagesBefore: null }, navigate);
    this.loadingThreadId = held ? null : threadId;
    const deselected = deselect ? s.selectDelegatedAgent(null) : Promise.resolve();
    let loaded = false;
    const summaryRead = preloaded?.summaryRead ?? this.ctx.threadReads.begin(threadId);
    let permissionRead: ReturnType<StoreContext['requests']['permissionRead']> | undefined;
    let questionRead: ReturnType<StoreContext['requests']['questionRead']> | undefined;
    let secretRead: ReturnType<StoreContext['requests']['secretRead']> | undefined;
    try {
      const previous = this.subscribedThreadId;
      // Everything this open needs leaves in one burst, in the order the core
      // must run it: on a 150 ms link, five calls awaited one after the other
      // were three quarters of a second before the last card was right, and the
      // messages waited behind a subscribe and an unsubscribe they do not need.
      const bundled = s.core?.features?.threadSnapshots === true;
      // A claimed press left the previous thread, the unread mark and the requests to this open.
      const { subscribed, fetched, around } = preloaded ?? askPage(this.ctx, this, client, threadId, held,
        { ...(previous && previous !== threadId && previous !== delegation.delegationSubscribedThreadId ? { previous } : {}), ...(options.requests === false ? { requests: false } : {}), markRead: true }, newest);
      const bundledRequests = bundled && !preloaded;
      if (options.requests !== false) {
        permissionRead = this.ctx.requests.permissionRead(client, threadId, bundledRequests ? () => fetched.then(thread => thread.opened?.permissions ?? []) : undefined);
        questionRead = this.ctx.requests.questionRead(client, threadId, bundledRequests ? () => fetched.then(thread => thread.opened?.questions ?? []) : undefined);
        secretRead = this.ctx.requests.secretRead(client, threadId, () => fetched.then(thread => this.ctx.requests.secretParts(thread)));
      }
      const permissionsAsked = permissionRead?.promise ?? Promise.resolve([]);
      const questionsAsked = questionRead?.promise ?? Promise.resolve([]);
      const secretsAsked = secretRead?.promise ?? Promise.resolve([]);
      // A run that a newer click overtakes returns early and never awaits these.
      for (const asked of [fetched, permissionsAsked, questionsAsked, secretsAsked]) asked.catch(() => undefined);
      await (subscribed ?? fetched);
      if (!newest()) {
        // A newer click took over while this one was in flight. Its own thread
        // is the one the socket keeps, so this subscription goes back.
        await retire();
        return;
      }
      const { opened: _opened, ...thread } = await fetched;
      if (!newest()) { await retire(); return; }
      const metadata = summaryRead.apply([summaryOf(thread)], this.threads).find(row => row.id === threadId);
      if (metadata) Object.assign(thread, metadata);
      this.upsertThread(summaryOf(thread));
      this.subscribedThreadId = threadId;
      // A thread already left that the core will not let go of costs a few
      // events, not the open of this one.
      const unsubscribed: Promise<unknown> = (!bundled || preloaded) && previous && previous !== threadId && previous !== delegation.delegationSubscribedThreadId && previous !== this.preloads.waitingThreadId
        ? client.call('threads.unsubscribe', { threadId: previous }).catch(() => undefined)
        : Promise.resolve();
      this.ctx.composer.settle(threadId);
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
        // A page around the reader's message keeps their place; any other starts at the end.
        if (!around || !freshIds.has(around)) this.readingPositions.delete(threadId);
      }
      // A window that now reaches the end says so, over the cursor a held copy had.
      if (held && thread.messagesAfter === undefined) delete held.messagesAfter;
      if (options.liveCreation && this.openThread?.id === threadId) mergeCreationSnapshot(thread, this.openThread);
      this.#show(held ? reconcileThread(held, thread) : thread, navigate, true);
      this.preloads.done(preloaded);
      loaded = true;
      this.loadingThreadId = null;
      this.loadingBytes = null;
      // The thread may already be waiting on a request this page never saw,
      // and may have had one settled where this client could not hear it.
      const permissions = await permissionsAsked;
      const questions = await questionsAsked;
      const secrets = await secretsAsked;
      await unsubscribed;
      if (!newest()) return;
      permissionRead?.apply(permissions);
      questionRead?.apply(questions);
      secretRead?.apply(secrets);
      // Its sub-agents asking the user show in its dock: their requests are read the same way.
      if (options.requests !== false) this.ctx.requests.readChildren(client, threadId);
      if (thread.unread) {
        await client.call('threads.markRead', { threadId });
        if (!newest()) return;
        thread.unread = false;
        this.threads = this.threads.map((t) => (t.id === threadId ? { ...t, unread: false } : t));
      }
    } catch (error) {
      if (newest()) {
        if (!loaded && error instanceof RpcFailure && (error.code === RpcErrorCode.NotFound || error.code === RpcErrorCode.Refused)) {
          if (previousThread && previousThread.id !== threadId
            && summaryRead.changes.get(previousThread.id) !== null) this.#show(previousThread, navigate);
          else {
            this.openThread = null;
            if (previousThread) s.startDraft(previousThread.projectId, { refresh: false });
          }
          // Rollback can remember the rejected target: discard it afterwards.
          this.readingThreads.delete(threadId);
          this.readingPositions.delete(threadId);
        }
        // The machine went while the thread opened: it shows offline, and the reconnect opens it again.
        if (!((wasDropped(error) || wasClosed(error)) && s.connection !== 'ready')) this.ctx.fail(error);
      }
      await retire();
    } finally {
      this.preloads.done(preloaded);
      summaryRead.cancel();
      permissionRead?.cancel();
      questionRead?.cancel();
      secretRead?.cancel();
      if (newest()) { this.loadingThreadId = null; this.loadingBytes = null; }
      await deselected;
    }
  }

  /** A plain visit becomes a new proxy on screen that does not write through to it: later changes go to what this answers. */
  #showHeld(held: Thread, navigate: boolean): Thread {
    this.#show(held, navigate);
    const shown = this.openThread;
    if (!shown || shown === held || shown.id !== held.id) return held;
    this.readingThreads.replace(held.id, held, shown);
    return shown;
  }

  /** Select the history synchronously; network work never owns navigation. */
  #show(thread: Thread, navigate: boolean, refreshTrace = false): void {
    const s = this.ctx.store;
    if (this.openThread?.id !== thread.id) this.#leaveFor(thread.id);
    this.openThread = thread;
    if (navigate) {
      s.page = this.pageOf(thread);
      s.sidebarOpen = false;
      if (thread.projectId) this.ctx.projects.rememberProject(thread.projectId);
      if (s.page === 'chat') this.lastChatThreadId = thread.id;
    }
    this.#traceOf(thread.id, refreshTrace);
  }

  /** What the thread on screen leaves behind when `next` replaces it, online or not. */
  #leaveFor(next: ThreadId): void {
    const s = this.ctx.store;
    const { delegation } = this.ctx;
    this.parts.leave();
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
    this.leaveArchived(next);
    this.ctx.requests.keepRequestsOf(next);
  }

  /** The workbench trace belongs to the thread on screen: another thread's rows go. */
  #traceOf(threadId: ThreadId, refresh: boolean): void {
    const s = this.ctx.store;
    const { workbench } = this.ctx;
    if (workbench.tracedThreadId !== threadId) s.trace = [];
    else if (refresh && s.traceWatched) void s.refreshTrace();
    workbench.tracedThreadId = threadId;
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
      this.#leaveFor(threadId);
      // A bare row has no messages in hand and says so: nothing above it to page in.
      this.openThread = held ? { ...held, ...row } : { ...row!, messages: [], turns: [], commands: [], messagesBefore: null };
    }
    this.#traceOf(threadId, false);
    if (navigate) {
      s.page = this.openThread ? this.pageOf(this.openThread) : 'chat';
      s.sidebarOpen = false;
      if (s.page === 'chat' && this.openThread) this.lastChatThreadId = this.openThread.id;
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
    const generation = ++this.#olderGeneration;
    const navigation = this.openGeneration;
    const current = () => generation === this.#olderGeneration && this.ctx.currentNavigation(client, navigation);
    try {
      const page = this.ctx.positions.noted(open.id, await client.call('messages.list', { threadId: open.id, before: cursor, maxBytes: READING_PAGE_BYTES, ...lightPage(this.ctx) }));
      const still = this.openThread;
      if (!current() || !still || still.id !== open.id || still.messagesBefore !== cursor) return 0;
      const known = new Set(still.messages.map((m) => m.id));
      const older = page.messages.filter((m) => !known.has(m.id));
      still.messages.unshift(...older);
      const knownTurns = new Set(still.turns.map((turn) => turn.id));
      // Older turns go first, as in the journal: the last one is the latest turn.
      still.turns.unshift(...(page.turns ?? []).filter((turn) => !knownTurns.has(turn.id)));
      still.messagesBefore = page.before;
      return older.length;
    } catch (error) {
      if (current()) this.ctx.fail(error);
      return 0;
    } finally {
      if (current()) this.loadingOlder = false;
    }
  }

  /** Hydrate only a card the reader opened (`store/deferred-parts.ts`). */
  loadToolOutput(threadId: ThreadId, messageId: MessageId, toolId: string): Promise<void> { return this.parts.toolOutput(threadId, messageId, toolId); }
  loadMessageAttachment(threadId: ThreadId, messageId: string, partIndex: number): Promise<string | null> { return this.parts.attachment(threadId, messageId, partIndex); }

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
    incognito?: boolean;
    preparationId?: string;
    subscribe?: boolean;
  }, options: { navigate?: boolean } = {}): Promise<ThreadSummary | null> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client) return null;
    const generation = this.openGeneration;
    try {
      const summary = await createWithPreparation(client, input, () => this.ctx.currentClient(client, clientGeneration));
      if (!this.ctx.currentClient(client, clientGeneration)) return null;
      this.upsertThread(summary);
      if (options.navigate !== false && this.ctx.currentNavigation(client, generation)) await this.ctx.store.open(summary.id);
      return summary;
    } catch (error) {
      if (this.ctx.currentNavigation(client, generation)) this.ctx.fail(error);
      return null;
    }
  }

  async update(
    threadId: ThreadId,
    patch: { title?: string; accountId?: string; model?: string | null; effort?: string | null; speed?: string | null; permissionMode?: PermissionMode; expectedSelectionVersion?: number }
  ): Promise<boolean> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client) return false;
    try {
      const summary = await client.call('threads.update', { threadId, ...patch });
      if (!this.ctx.currentClient(client, clientGeneration)) return false;
      this.upsertThread(summary);
      const open = this.openThread;
      if (open && open.id === threadId) patchFields(open, summary);
      return true;
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
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
    const clientGeneration = this.ctx.clientGeneration;
    if (!client || this.retitling.includes(threadId)) return;
    this.retitling = [...this.retitling, threadId];
    try {
      const summary = await client.call('threads.retitle', { threadId });
      if (!this.ctx.currentClient(client, clientGeneration)) return;
      this.upsertThread(summary);
      const open = this.openThread;
      if (open && open.id === threadId) patchFields(open, summary);
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
    } finally {
      if (this.ctx.currentClient(client, clientGeneration)) this.retitling = this.retitling.filter((id) => id !== threadId);
    }
  }

  async pin(threadId: ThreadId, pinned: boolean): Promise<void> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client) return;
    try {
      const shown = [this.threads.find((t) => t.id === threadId), this.openThread?.id === threadId ? this.openThread : null];
      const summary = await pinWhile(shown, pinned, () => client.call('threads.pin', { threadId, pinned }));
      if (!this.ctx.currentClient(client, clientGeneration)) return;
      this.upsertThread(summary);
      const open = this.openThread;
      if (open && open.id === threadId) open.pinned = summary.pinned;
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
    }
  }

  /**
   * The owner accepts the contact mail that holds this thread
   * (`Thread.contactHold`), so its turns run again. Resolves whether the core
   * took it; a refusal is reported like any failed action.
   */
  async trustContactHistory(threadId: ThreadId): Promise<boolean> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client) return false;
    try {
      await client.call('threads.trustContactHistory', { threadId });
      // The core announces the cleared hold before it answers; clearing it here
      // again would erase a hold a letter set in between.
      return this.ctx.currentClient(client, clientGeneration);
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
      return false;
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
    const clientGeneration = this.ctx.clientGeneration;
    if (!client) return null;
    try {
      const summary = await call(client);
      if (!this.ctx.currentClient(client, clientGeneration)) return null;
      this.upsertThread(summary);
      const open = this.openThread;
      if (open && open.id === threadId) patchFields(open, summary);
      return summary;
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
      return null;
    }
  }

  async archive(threadId: ThreadId, onlyIfIdle = false): Promise<void> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client) return;
    const navigationGeneration = this.openGeneration;
    try {
      await archiveWhile(() => this.threads, threadId, client.call('threads.archive', { threadId, archived: true, ...(onlyIfIdle ? { onlyIfIdle: true } : {}) }));
      if (!this.ctx.currentClient(client, clientGeneration)) return;
      this.ctx.threadReads.change(threadId, null);
      this.threads = this.threads.filter((t) => t.id !== threadId);
      this.ctx.requests.dropRequestsOf(threadId);
      if (this.openThread?.id === threadId && this.openGeneration === navigationGeneration) this.ctx.store.startDraft(this.openThread.projectId, { refresh: false });
      this.forgetThread(threadId);
    } catch (error) {
      if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
    }
  }

  async removeThread(threadId: ThreadId): Promise<boolean> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client) return false;
    try {
      await client.call('threads.remove', { threadId });
      if (!this.ctx.currentClient(client, clientGeneration)) return false;
      await this.removed(threadId);
      return true;
    } catch (error) {
      if (!this.ctx.currentClient(client, clientGeneration)) return false;
      if (error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound) {
        this.ctx.store.error = strings.sidebar.deleteUnavailable;
      } else if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error);
      return false;
    }
  }

  async restoreDeletedThread(threadId: ThreadId): Promise<ThreadSummary | null> {
    const client = this.ctx.client;
    const clientGeneration = this.ctx.clientGeneration;
    if (!client) return null;
    try {
      const summary = await client.call('threads.restore', { threadId });
      if (!this.ctx.currentClient(client, clientGeneration)) return null;
      this.upsertThread(summary);
      return summary;
    } catch (error) { if (this.ctx.currentClient(client, clientGeneration)) this.ctx.fail(error); return null; }
  }

  /** Applied to this machine only, for both RPC answers and removal events. */
  async removed(threadId: ThreadId): Promise<void> {
    this.ctx.threadReads.change(threadId, null);
    const s = this.ctx.store;
    const openingOther = this.loadingThreadId !== null && this.loadingThreadId !== threadId;
    this.threads = this.threads.filter(t => t.id !== threadId);
    forgetArchivedThread(s, threadId);
    this.ctx.requests.dropRequestsOf(threadId);
    if (this.#openTarget === threadId) { this.openGeneration++; this.#openTarget = null; }
    if (s.delegationThread?.id === threadId) s.delegationThread = null;
    if (this.openThread?.id === threadId && !openingOther) s.startDraft(this.openThread.projectId, { refresh: false });
    this.forgetThread(threadId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async unsubscribe(): Promise<void> {
    this.invalidateNavigation();
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

  /** The row of `threadId` the list holds, through the id index. */
  rowOf(threadId: ThreadId): ThreadSummary | undefined { return this.#rowIndex.of(this.threads, threadId); }

  upsertThread(summary: ThreadSummary): void {
    this.ctx.threadReads.change(summary.id, summary);
    const row = this.rowOf(summary.id);
    if (row) patchRow(row, keepArchived(row, summary));
    else this.#rowIndex.push(this.threads, summary);
  }

  /** Drops reading state; automatic archives can retain unsent input for restoration. */
  forgetThread(threadId: ThreadId, preserveInput = false): void {
    const s = this.ctx.store;
    const composer = this.ctx.composer;
    if (preserveInput) {
      const input = s.composerStates[threadId];
      if (input) input.paused = true;
    } else {
      delete s.composerStates[threadId];
      composer.previewUndo.delete(s.threadKey(threadId));
      composer.pendingSends.delete(threadId);
      delete composer.staged[threadId];
      rightPanel.forget(s.threadKey(threadId));
    }
    this.readingThreads.delete(threadId);
    this.readingPositions.delete(threadId);
    if (s.terminalShown(threadId)) s.hideTerminal(threadId);
  }

  /** The open thread, archived from another client, stayed on screen with its panel; leaving it lets that go. */
  leaveArchived(next: ThreadId | null): void {
    const left = this.openThread;
    if (left?.archived && left.id !== next) this.forgetThread(left.id, left.archiveReason?.type === 'pr-merged');
  }

  threadSnapshots(threadId: ThreadId): Thread[] {
    return threadCopies(threadId, this.openThread, this.ctx.store.delegationThread, this.preloads.pages());
  }

  messages(threadId: ThreadId, messageId: string): Message[] {
    return messageCopies(this.threadSnapshots(threadId), messageId);
  }

  invalidateSync(threadId: ThreadId): void {
    for (const thread of this.threadSnapshots(threadId)) delete thread.messagesSync;
  }

  upsertTurn(threadId: ThreadId, turn: Thread['turns'][number]): void {
    for (const thread of this.threadSnapshots(threadId)) {
      const index = lastIndexById(thread.turns, turn.id);
      if (index >= 0) thread.turns[index] = turn;
      else thread.turns.push(turn);
    }
  }
}
