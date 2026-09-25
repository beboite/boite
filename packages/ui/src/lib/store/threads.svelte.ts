import type {
  Message,
  MessageId,
  PermissionMode,
  ProjectId,
  ProviderId,
  Thread,
  ThreadId,
  ThreadSummary
} from '@boite/contracts';
import { fitsReadingCache } from '../reading-cache';
import { rightPanel } from '../right-panel.svelte';
import { lastIndexById, mergeResumed, patchRow, resumeRequest, threadsByProject } from '../thread-rows';
import type { StoreContext } from './context';

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
  /** The threads a `threads.retitle` is out for: their menu item waits. */
  retitling = $state<ThreadId[]>([]);
  readonly readingPositions = new Map<string, { top: number; pinned: boolean; heights: Map<string, number>; anchor?: { id: string; offset: number } }>();
  readingThreads = new Map<string, Thread>();
  subscribedThreadId: ThreadId | null = null;
  /** The number of the newest `open()`, so an older one writes nothing. */
  openGeneration = 0;
  /** What that newest run is opening, so an older one knows what to give back. */
  #openTarget: ThreadId | null = null;

  constructor(private readonly ctx: StoreContext) {}

  rememberReadingThread(): void {
    const thread = this.openThread;
    if (!thread) return;
    // Four recent timelines, with at most 4 MB of text/image data each.
    // The active timeline remains unrestricted; old visits must not retain every image forever.
    this.readingThreads.delete(thread.id);
    if (fitsReadingCache(thread.messages)) this.readingThreads.set(thread.id, thread);
    while (this.readingThreads.size > 4) this.readingThreads.delete(this.readingThreads.keys().next().value!);
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
   * Two clicks inside one round trip are one thread: the newest run owns the
   * screen and the subscription, and an older one writes nothing, not even
   * `subscribedThreadId`. The order is subscribe then unsubscribe, so a
   * refused subscribe leaves the thread on screen with the socket it had
   * rather than with none at all.
   */
  async open(threadId: ThreadId, navigate = true): Promise<void> {
    const s = this.ctx.store;
    const { delegation, workbench } = this.ctx;
    const client = this.ctx.client;
    if (!client) return;
    const generation = ++this.openGeneration;
    this.#openTarget = threadId;
    const newest = (): boolean => this.openGeneration === generation;
    if (this.openThread?.id !== threadId && s.delegationSelectedAgentId && s.delegationSelectedAgentId !== threadId) {
      await s.selectDelegatedAgent(null);
      if (!newest()) return;
    }
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
      const held = this.openThread?.id === threadId ? this.openThread : this.readingThreads.get(threadId);
      const fetched = client.call('threads.get', resumeRequest(threadId, held));
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
      this.rememberReadingThread();
      const cached = this.readingThreads.get(threadId);
      const freshIds = new Set(thread.messages.map(m => m.id));
      if (thread.messagesFrom !== undefined && held) mergeResumed(held, thread);
      else if (cached && cached.messages.some(m => freshIds.has(m.id))) {
        const merged = new Map(cached.messages.map(m => [m.id, m]));
        for (const message of thread.messages) merged.set(message.id, message);
        thread.messages = [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
        thread.messagesBefore = cached.messagesBefore;
      } else {
        this.readingThreads.delete(threadId);
        this.readingPositions.delete(threadId);
      }
      s.draft = null;
      // The last page, pinned to the bottom; what is above it arrives on scroll.
      this.loadingOlder = false;
      if (this.openThread?.id !== threadId) {
        delegation.delegationEpoch++;
        delegation.delegationConfigureEpoch++;
        s.delegation = null;
        s.delegationLoading = false;
        s.delegationSaving = false;
        s.delegationError = null;
      }
      this.leaveArchived(threadId);
      this.openThread = thread;
      // The thread that was open takes its permission and question cards with it.
      this.ctx.requests.keepRequestsOf(threadId);
      if (navigate) {
        s.page = 'chat';
        s.sidebarOpen = false;
        if (thread.projectId) this.ctx.projects.rememberProject(thread.projectId);
      }
      // The trace is read by its surface alone, so it is fetched only while
      // that surface is on screen, and never in the way of the messages.
      // A new thread empties it and the surface's own effect reads the new
      // one; the same thread again is a reconnect, which that effect never sees.
      if (workbench.tracedThreadId !== threadId) s.trace = [];
      else if (s.traceWatched) void s.refreshTrace();
      workbench.tracedThreadId = threadId;
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
        thread.unread = false;
        this.threads = this.threads.map((t) => (t.id === threadId ? { ...t, unread: false } : t));
      }
    } catch (error) {
      if (newest()) this.ctx.fail(error);
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
    try {
      const page = await client.call('messages.list', { threadId: open.id, before: cursor });
      const still = this.openThread;
      if (!still || still.id !== open.id || still.messagesBefore !== cursor) return 0;
      const known = new Set(still.messages.map((m) => m.id));
      const older = page.messages.filter((m) => !known.has(m.id));
      still.messages.unshift(...older);
      const knownTurns = new Set(still.turns.map((turn) => turn.id));
      // Older turns go first, as in the journal: the last one is the latest turn.
      still.turns.unshift(...(page.turns ?? []).filter((turn) => !knownTurns.has(turn.id)));
      still.messagesBefore = page.before;
      return older.length;
    } catch (error) {
      this.ctx.fail(error);
      return 0;
    } finally {
      this.loadingOlder = false;
    }
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

  /** What the UI keeps per thread, dropped once the thread is archived or gone: the UI cannot unarchive. */
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
