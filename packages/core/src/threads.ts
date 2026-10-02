import { archiveState, archiveStateKey } from './merged-pr-archive-state.ts';
import { repositoryOf, type MergedPrProof } from './pull-requests.ts';
import type { AgentProfile } from '@boite/contracts';
import { createHash } from 'node:crypto';
import { previewReferencesError, previewPrompt, MESSAGE_PAGE, MESSAGE_PAGE_MAX, DEFAULT_THREAD_DELETION_RETENTION_DAYS } from '@boite/contracts';
import type {
  Account,
  AccountId,
  Attachment,
  PreviewReference,
  ThreadLink,
  ImageMimeType,
  Message,
  MessageId,
  MessagePart,
  PermissionRequest,
  Project,
  ProjectId,
  ProviderDescriptor,
  QuestionRequest,
  RequestId,
  RpcParams,
  Thread,
  ThreadId,
  ThreadRewind,
  ThreadStatus,
  ThreadSummary,
  Turn,
  TurnId,
  TurnInFlightData,
} from '@boite/contracts';
import type { Core } from './core.ts';
import { threadTerminalId } from './terminals.ts';
import { notFound, refused } from './errors.ts';
import { newId } from './ids.ts';
import { assertDriverRunnable, releaseThread } from './drivers/index.ts';
import { AgentState } from './threads/agent-state.ts';
import { ThreadBranching } from './threads/branching.ts';
import { CodeCheckpoints } from './threads/code-checkpoints.ts';
import { ThreadCards } from './threads/cards.ts';
import { AUTO_COMPACT_LABEL, AutoCompaction } from './threads/auto-compact.ts';
import { DeferredInput } from './threads/deferred.ts';
import { MOVE_NOTE_PREFIX, pendingMove, ThreadMove } from './threads/move.ts';
import { ThreadSpawns } from './threads/spawn.ts';
import { checkAttachmentArray, checkAttachments, checkCwd, draftFolderName, makeDraftFolder, titleOf } from './threads/inputs.ts';
import { RestartHandoff } from './threads/handoff.ts';
import { SYSTEM_LABEL, nativeCommandPrompt, systemOperation } from './threads/operations.ts';
import { saveThread, setThreadStatus, withLoad } from './threads/records.ts';
import { ThreadRecovery } from './threads/recovery.ts';
import { ThreadTitles } from './threads/retitle.ts';
import { readMemoryEvents } from './threads/memory-read.ts';
import { checkEffort, checkModel, checkSpeed, checkStoredEffort, defaultModel } from './threads/selection.ts';
import { TurnContexts } from './threads/turn-context.ts';
import { TurnRunner } from './threads/turn-runner.ts';
import { ThreadFocus } from './threads/focus.ts';
import { ProgressState } from './threads/progress.ts';

type CreateParams = RpcParams<'threads.create'>;

/**
 * The threads of this core: what the RPC and the other modules call. Each part
 * under `threads/` owns its own state; the store builds them and hands them
 * itself, so a part reaches another through it.
 */
export class ThreadStore {
  /** Internal-only entry: callers supply an already authorized workspace, never a fabricated project. */
  createAgentSession(agent: AgentProfile, sessionId: string, cwd: string, projectId: string | null = null, branch: string | null = null): ThreadSummary {
    const provider = this.core.providers.require(agent.selection.providerId);
    const account = this.core.accounts.require(agent.selection.accountId);
    if (account.providerId !== provider.id) throw refused('agent account belongs to another provider');
    const now = Date.now();
    const thread: ThreadSummary = {
      id: newId('thr_'), projectId, agentSessionId: sessionId, title: agent.name, titleSource: 'user',
      ...agent.selection, speed: null, cwd, branch, status: 'idle', unread: false, archived: false, pinned: false,
      sessionId: null, sessionGeneration: 0, selectionVersion: 0, load: null, context: null, createdAt: now, updatedAt: now,
    };
    this.core.journal.append({ type: 'thread.created', threadId: thread.id, version: 1, payload: thread }, () => this.core.journal.putThread(thread));
    return thread;
  }

  /** Runs each turn and owns the handles of the running ones. */
  readonly runner: TurnRunner;
  /** Builds what a driver gets for a turn. */
  readonly contexts: TurnContexts;
  readonly focus: ThreadFocus;
  readonly progress: ProgressState;
  /** Permission and question cards. */
  readonly cards: ThreadCards;
  /** Held asynchronous answers and wakes. */
  readonly deferred: DeferredInput;
  /** Commands, background tasks and context the agent reported. */
  readonly agentState: AgentState;
  readonly titles: ThreadTitles;
  /** `threads.rewind` and `threads.fork`. */
  readonly branching: ThreadBranching;
  readonly codeCheckpoints: CodeCheckpoints;
  /** `threads.move`. */
  readonly moves: ThreadMove;
  /** `agent.spawn`. */
  readonly spawns: ThreadSpawns;
  /** The `autoCompact` setting: compactions the core opens between turns. */
  readonly autoCompact: AutoCompaction;
  private readonly recovery: ThreadRecovery;
  /** Turns a restart hands to the next core (`threads/handoff.ts`). */
  readonly handoff: RestartHandoff;
  private readonly removing = new Set<ThreadId>();

  constructor(private readonly core: Core) {
    this.runner = new TurnRunner(core, this);
    this.contexts = new TurnContexts(core, this);
    this.focus = new ThreadFocus(core);
    this.progress = new ProgressState(core);
    this.cards = new ThreadCards(core, this);
    this.deferred = new DeferredInput(core, this);
    this.agentState = new AgentState(core);
    this.titles = new ThreadTitles(core, this);
    this.branching = new ThreadBranching(core, this);
    this.codeCheckpoints = new CodeCheckpoints(core);
    this.moves = new ThreadMove(core, this);
    this.spawns = new ThreadSpawns(core, this);
    this.autoCompact = new AutoCompaction(core, this);
    this.recovery = new ThreadRecovery(core);
    this.handoff = new RestartHandoff(core, this);
  }

  // -- reads ----------------------------------------------------------------

  list(params: { projectId?: ThreadId; includeArchived?: boolean }): ThreadSummary[] {
    const threads = this.core.journal.listThreads(params.projectId);
    const withLoad = threads.map((thread) => this.withLoad(thread));
    if (params.includeArchived === true) return withLoad;
    return withLoad.filter((thread) => !thread.archived);
  }

  require(threadId: ThreadId): ThreadSummary {
    const thread = this.core.journal.getThread(threadId);
    if (thread === null) throw notFound(`unknown thread ${threadId}`, { threadId });
    return thread;
  }

  /**
   * The thread with its last page of messages. A thousand-message thread costs
   * one page here; the rest is walked back through `messages`, whose cursor is
   * `messagesBefore`.
   */
  get(threadId: ThreadId, after?: MessageId): Thread {
    const thread = this.withLoad(this.require(threadId));
    // A snapshot taken mid-stream holds every delta up to this line, and every
    // one of them has left for the sockets: what arrives after the answer is
    // text the answer does not have.
    this.core.journal.flushDeltas();
    this.core.bus.flush();
    const fromRowid = after === undefined ? null : this.core.journal.messageRowid(threadId, after);
    const tail = fromRowid === null ? null : this.core.journal.listMessagesFrom(threadId, fromRowid, MESSAGE_PAGE);
    const page = tail === null
      ? this.core.journal.listMessagePage(threadId, { limit: MESSAGE_PAGE })
      : { messages: tail, before: null };
    return {
      ...thread,
      ...(tail === null || after === undefined ? {} : { messagesFrom: after }),
      messages: page.messages,
      memoryEvents: readMemoryEvents(this.core.journal, threadId),
      commands: this.agentState.commands.get(threadId) ?? [],
      background: this.agentState.background.get(threadId) ?? [],
      activity: this.core.activity.get(threadId),
      messagesBefore: page.before,
      // The turns of that page and the ones still in flight, never the whole history.
      turns: this.core.journal.listTurnsFor(
        threadId,
        page.messages.map((message) => message.turnId),
      ),
    };
  }

  /**
   * One page of messages older than `before`, oldest first inside the page. An
   * unknown thread is a not-found; a cursor that is not a message of that thread
   * is refused by name rather than answered with an empty page.
   */
  messages(params: { threadId: ThreadId; before: MessageId; limit?: number }): {
    messages: Message[];
    before: MessageId | null;
    turns: Turn[];
  } {
    this.require(params.threadId);
    const rowid = this.core.journal.messageRowid(params.threadId, params.before);
    if (rowid === null) {
      throw refused(`message ${params.before} is not a message of thread ${params.threadId}`, {
        threadId: params.threadId,
        before: params.before,
      });
    }
    const asked = params.limit ?? MESSAGE_PAGE;
    const limit = Math.min(Math.max(1, Math.trunc(asked)), MESSAGE_PAGE_MAX);
    const page = this.core.journal.listMessagePage(params.threadId, { beforeRowid: rowid, limit });
    return { ...page, turns: this.core.journal.listTurnsFor(params.threadId, page.messages.map((message) => message.turnId)) };
  }

  // -- writes ---------------------------------------------------------------

  /**
   * The thread in its own git worktree: the branch and directory are made
   * first, under the id the thread will carry, and the record is written only
   * once git succeeded. Everything a refusal can come from is checked before
   * git makes anything, and a refusal after that removes the worktree and its
   * branch again, so nothing is left behind but the trace of the git processes.
   */
  async createInWorktree(params: CreateParams): Promise<ThreadSummary> {
    if (params.cwd !== undefined) {
      throw refused('cwd and worktree exclude each other: a worktree is the working directory', { cwd: params.cwd });
    }
    const { project, provider, account } = this.check(params);
    if (project.kind === 'drafts') {
      throw refused('a draft has no worktree: the drafts folder is not a git repository', { projectId: project.id });
    }
    const model = checkModel(provider, account.id, params.model ?? defaultModel(provider));
    checkEffort(provider, account.id, model, params.effort ?? null);
    checkSpeed(provider, account.id, model, params.speed ?? null);
    const id = newId('thr_');
    const placed = await this.core.worktrees.add(id, project, params.worktree?.branch);
    try {
      return this.create({ ...params, cwd: placed.path }, { id, branch: placed.branch, branchNamingPending: placed.namingPending });
    } catch (error) {
      await this.core.worktrees.remove(id, project, placed);
      throw error;
    }
  }

  create(params: CreateParams, placed?: { id: ThreadId; branch: string | null; branchNamingPending?: boolean; parentThreadId?: ThreadId }): ThreadSummary {
    const { project, provider, account } = this.check(params);

    const now = Date.now();
    const model = checkModel(provider, account.id, params.model ?? defaultModel(provider));
    const effort = checkEffort(provider, account.id, model, params.effort ?? null);
    const speed = checkSpeed(provider, account.id, model, params.speed ?? null);
    // A worktree's directory is the core's own and uses the configured storage;
    // anything a client names has to be inside it. A draft with no directory
    // named gets a new folder of its own, made once everything else passed.
    const cwd =
      params.cwd !== undefined && params.cwd.length > 0
        ? placed !== undefined
          ? params.cwd
          : checkCwd(project, params.cwd)
        : project.kind === 'drafts'
          ? makeDraftFolder(project.path, draftFolderName(titleOf(params.title), new Date(now)))
          : project.path;
    const thread: ThreadSummary = {
      id: placed?.id ?? newId('thr_'),
      ...(placed?.parentThreadId ? { parentThreadId: placed.parentThreadId } : {}),
      projectId: project.id,
      title: titleOf(params.title),
      titleSource: 'prompt',
      providerId: provider.id,
      accountId: account.id,
      model,
      effort,
      speed,
      cwd,
      branch: placed?.branch ?? null,
      branchNamingPending: placed?.branchNamingPending ?? false,
      permissionMode: params.permissionMode ?? 'default',
      status: 'idle',
      unread: false,
      archived: false,
      pinned: false,
      sessionId: null,
      load: null,
      context: null,
      createdAt: now,
      updatedAt: now,
    };
    this.core.journal.append({ type: 'thread.created', threadId: thread.id, version: 1, payload: thread }, () => {
      this.core.journal.putThread(thread);
    });
    this.core.bus.emit('thread.created', thread);
    // A thread started in a project put away says the project is in use again.
    if (project.archived === true) this.core.projects.archive(project.id, false);
    return thread;
  }

  /**
   * A thread with a history it never ran: one finished turn per prompt of an
   * imported transcript, written with the thread in one transaction so no
   * client ever sees it empty, and the session id set so the next turn
   * resumes the agent's own session.
   */
  createImported(
    params: CreateParams,
    history: {
      sessionId: string;
      titleSource: ThreadSummary['titleSource'];
      turns: {
        prompt: string;
        images: { mimeType: ImageMimeType; data: string }[];
        promptAt: number;
        parts: MessagePart[];
        answerAt: number | null;
        lastAt: number;
      }[];
    },
  ): ThreadSummary {
    const { project, provider, account } = this.check(params);
    const now = Date.now();
    const first = history.turns[0];
    const last = history.turns[history.turns.length - 1];
    const model = checkModel(provider, account.id, params.model ?? defaultModel(provider));
    const thread: ThreadSummary = {
      id: newId('thr_'),
      projectId: project.id,
      title: titleOf(params.title),
      titleSource: history.titleSource,
      providerId: provider.id,
      accountId: account.id,
      model,
      effort: null,
      cwd: params.cwd !== undefined && params.cwd.length > 0 ? params.cwd : project.path,
      branch: null,
      permissionMode: params.permissionMode ?? 'default',
      status: 'idle',
      unread: false,
      archived: false,
      pinned: false,
      sessionId: history.sessionId,
      load: null,
      context: null,
      createdAt: first?.promptAt || now,
      updatedAt: last?.lastAt || now,
    };
    const rows: { turn: Turn; messages: Message[] }[] = history.turns.map((entry) => {
      const turn: Turn = {
        id: newId('trn_'),
        threadId: thread.id,
        status: 'done',
        queuedAt: entry.promptAt,
        startedAt: entry.promptAt,
        finishedAt: entry.lastAt,
        usage: null,
        error: null,
      };
      const messages: Message[] = [
        {
          id: newId('msg_'),
          threadId: thread.id,
          turnId: turn.id,
          role: 'user',
          parts: [
            { type: 'text', text: entry.prompt },
            ...entry.images.map((image): MessagePart => ({ type: 'image', mimeType: image.mimeType, data: image.data, alt: null })),
          ],
          state: 'complete',
          createdAt: entry.promptAt,
        },
      ];
      if (entry.parts.length > 0) {
        messages.push({
          id: newId('msg_'),
          threadId: thread.id,
          turnId: turn.id,
          role: 'assistant',
          parts: entry.parts,
          state: 'complete',
          createdAt: entry.answerAt ?? entry.promptAt,
        });
      }
      return { turn, messages };
    });
    this.core.journal.append({ type: 'thread.imported', threadId: thread.id, version: 1, payload: thread }, () => {
      this.core.journal.putThread(thread);
      for (const row of rows) {
        this.core.journal.putTurn(row.turn);
        for (const message of row.messages) this.core.journal.putMessage(message);
      }
    });
    this.core.bus.emit('thread.created', thread);
    return thread;
  }

  /** The project, provider and account a new thread names, each refused by name when wrong. */
  private check(params: CreateParams): { project: Project; provider: ProviderDescriptor; account: Account } {
    const project = this.core.projects.require(params.projectId);
    const provider = this.core.providers.require(params.providerId);
    const account = this.core.accounts.require(params.accountId);
    if (account.providerId !== provider.id) {
      throw refused('the account belongs to another provider', {
        accountId: account.id,
        accountProviderId: account.providerId,
        providerId: provider.id,
      });
    }
    return { project, provider, account };
  }

  update(params: {
    threadId: ThreadId;
    accountId?: AccountId;
    expectedSelectionVersion?: number;
    title?: string;
    model?: string | null;
    effort?: string | null;
    speed?: string | null;
    permissionMode?: ThreadSummary['permissionMode'];
  }): ThreadSummary {
    const thread = this.require(params.threadId);
    this.checkSelection(thread, params.expectedSelectionVersion);
    const next: ThreadSummary = { ...thread };
    // A title the user typed is theirs: no turn and no retitle overwrites it unasked.
    if (params.title !== undefined && params.title.length > 0) {
      next.title = params.title;
      next.titleSource = 'user';
      next.titleState = { version: (thread.titleState?.version ?? 0) + 1, needsRefinement: false };
    }
    const account = this.core.accounts.require(params.accountId ?? thread.accountId);
    const switched = account.id !== thread.accountId;
    const provider = this.core.providers.require(account.providerId);
    if (switched) {
      assertDriverRunnable(provider.protocol, this.core.providers.summary(provider.id), account, () => this.core.providers.launcherScriptOnly(provider.id));
      next.accountId = account.id;
      next.providerId = provider.id;
      next.model = checkModel(provider, account.id, params.model === undefined ? defaultModel(provider) : params.model);
      next.effort = null;
      next.speed = null;
      next.sessionId = null;
      next.sessionResumeAt = null;
      next.sessionGeneration = (thread.sessionGeneration ?? 0) + 1;
      next.context = null;
    }
    if (params.model !== undefined && (params.model !== thread.model || switched)) {
      // A new model starts on its own default unless the call says otherwise.
      next.model = checkModel(provider, account.id, params.model);
      next.effort = null;
      next.speed = null;
    }
    if (params.permissionMode !== undefined) next.permissionMode = params.permissionMode;
    if (params.effort !== undefined) next.effort = params.effort;
    if (params.speed !== undefined) next.speed = params.speed;
    next.speed = checkSpeed(provider, account.id, next.model, next.speed ?? null);
    // The model may have changed in the same call, so the scale is the new one's.
    next.effort = checkEffort(provider, account.id, next.model, next.effort);
    if (switched || next.model !== thread.model || next.effort !== thread.effort || next.speed !== thread.speed || next.permissionMode !== thread.permissionMode) {
      next.selectionVersion = (thread.selectionVersion ?? 0) + 1;
    }
    if (switched) {
      if (!['queued', 'running', 'waiting'].includes(thread.status)) {
        this.releaseAgent(thread.id);
        this.agentState.noteBackground(thread.id, []);
      }
      this.agentState.commands.delete(thread.id);
      this.core.bus.emit('thread.commands', { threadId: thread.id, commands: [] });
    }
    return this.save(next, 'thread.updated');
  }

  private checkSelection(thread: ThreadSummary, expected?: number): void {
    if (expected !== undefined && expected !== (thread.selectionVersion ?? 0)) {
      throw refused('the model selection changed; review the selected model and send again', { threadId: thread.id });
    }
  }

  isRemoving(threadId: ThreadId): boolean { return this.removing.has(threadId); }

  /** A quiescent automatic archive changes visibility only, retaining the checkout and execution state. */
  archiveMergedPr(expected: ThreadSummary, proof: MergedPrProof, generation: number): ThreadSummary | null {
    const thread = this.core.journal.getThread(expected.id);
    const state = archiveState(this.core.journal, expected.id);
    const project = thread?.projectId ? this.core.journal.getProject(thread.projectId) : null;
    if (!thread || !project || repositoryOf(thread.cwd) !== proof.checkoutRepository || repositoryOf(project.path) !== proof.checkoutRepository) return null;
    if (!thread || thread.updatedAt !== expected.updatedAt || thread.cwd !== expected.cwd || thread.branch !== proof.branch || thread.projectId !== expected.projectId || state.generation !== generation || state.dismissed?.includes(proof.url) || !this.core.mergedPrArchive.eligible(thread)) return null;
    return this.core.bus.afterCommit(() => this.core.journal.db.transaction(() => {
      this.core.journal.setSetting(archiveStateKey(thread.id), { ...state, binding: proof, reason: { type: 'pr-merged', number: proof.number, url: proof.url, archivedAt: Date.now() } });
      const saved = this.save({ ...thread, archived: true }, 'thread.archived');
      if (thread.projectId !== null) this.core.projects.announce(thread.projectId);
      return saved;
    })());
  }

  archive(threadId: ThreadId, archived: boolean): ThreadSummary {
    this.require(threadId);
    if (!archived && this.removing.has(threadId)) throw refused('threadId: this conversation is being deleted', { threadId, field: 'threadId', expected: 'a conversation not being deleted' });
    // An archived thread is not coming back this minute: its warm process goes
    // now, and the commands that process listed go with it.
    if (archived) {
      this.moves.forget(threadId);
      this.core.delegation.stop(threadId);
      this.core.scheduler.stop(threadId);
      this.releaseAgent(threadId);
      this.agentState.commands.delete(threadId);
      this.agentState.noteBackground(threadId, []);
      // Nobody answers a card on a thread put away, and no turn should start from one.
      this.cards.clearQuestionsOf(threadId, true);
      this.deferred.deferredAnswers.delete(threadId);
      this.deferred.pendingWakes.delete(threadId);
      void this.core.terminals.close(threadTerminalId(threadId));
    }
    const thread = this.require(threadId);
    return this.core.bus.afterCommit(() => this.core.journal.db.transaction(() => {
      if (!archived) {
        const state = archiveState(this.core.journal, threadId);
        const dismissed = [...new Set([...(state.dismissed ?? []), ...(state.binding ? [state.binding.url] : [])])];
        this.core.journal.setSetting(archiveStateKey(threadId), { ...state, reason: undefined, generation: state.generation + 1, dismissed, restoredCheckout: { projectId: thread.projectId, cwd: thread.cwd, branch: thread.branch } });
      }
      const saved = this.save({ ...thread, archived }, 'thread.archived');
      if (thread.archived !== archived && !thread.parentThreadId && thread.projectId !== null) this.core.projects.announce(thread.projectId);
      return saved;
    })());
  }

  markRead(threadId: ThreadId): void {
    const thread = this.require(threadId);
    if (!thread.unread) return;
    this.save({ ...thread, unread: false }, 'thread.read');
  }

  async remove(threadId: ThreadId): Promise<void> {
    const root = this.require(threadId);
    if (root.agentSessionId || root.parentThreadId) {
      throw refused('threadId: delete a conversation from its parent; persistent agent sessions are managed through Agents', { threadId, field: 'threadId', expected: 'a top-level conversation without agentSessionId' });
    }
    if (this.removing.has(threadId)) throw refused('threadId: this conversation is already being deleted', { threadId, field: 'threadId', expected: 'a conversation not being deleted' });
    const family = this.core.journal.listThreads().filter(t => t.id === threadId || t.parentThreadId === threadId);
    for (const thread of family) this.removing.add(thread.id);
    try {
      this.core.workflows.stopRoot(threadId, 'Conversation deleted');
      for (const thread of family) this.archive(thread.id, true);
      await Promise.all(family.map(thread => this.core.scheduler.stopAndWait(thread.id)));
      await Promise.all(family.flatMap(thread => [
        this.core.procs.stopAndWait(thread.id),
        this.core.procs.stopAndWait(threadTerminalId(thread.id)),
      ]));
      const ids = family.map(thread => thread.id);
      this.core.journal.append(
        { type: 'thread.removed', threadId: null, version: 1, payload: { threadIds: ids } },
        () => this.core.journal.stageThreadDeletion(threadId, family),
      );
      for (const id of ids) this.core.bus.emit('thread.removed', { threadId: id, undoable: true });
      this.core.bus.emit('thread.deletionsUpdated', {});
      if (root.projectId !== null && this.core.journal.getProject(root.projectId)) this.core.projects.announce(root.projectId);
    } finally {
      for (const thread of family) this.removing.delete(thread.id);
    }
  }

  restoreDeleted(threadId: ThreadId): ThreadSummary {
    this.purgeDeleted();
    const root = this.core.journal.listDeletedThreads().find(t => t.id === threadId);
    if (!root) throw notFound(`threadId: no recoverable deletion for ${threadId}`, { threadId });
    if (root.projectId !== null) this.core.projects.require(root.projectId);
    const ids = this.core.journal.append(
      { type: 'thread.restored', threadId, version: 1, payload: { threadId } },
      () => this.core.journal.restoreDeletedThreads(threadId),
    );
    for (const id of ids) this.core.bus.emit('thread.created', this.withLoad(this.require(id)));
    this.core.bus.emit('thread.deletionsUpdated', {});
    if (root.projectId !== null) this.core.projects.announce(root.projectId);
    return this.withLoad(this.require(threadId));
  }

  /** Expiry uses the deletion date, never the conversation's creation or last message. */
  purgeDeleted(): void {
    const days = this.core.settings.get().threadDeletionRetentionDays ?? DEFAULT_THREAD_DELETION_RETENTION_DAYS;
    if (days === 0) return;
    if (this.core.journal.purgeDeletedThreads(Date.now() - days * 86_400_000) > 0) {
      this.core.bus.emit('thread.deletionsUpdated', {});
    }
  }

  pin(threadId: ThreadId, pinned: boolean): ThreadSummary {
    const thread = this.require(threadId);
    // Pinning twice is not a change: no journal row, no event, the same summary back.
    if (thread.pinned === pinned) return this.withLoad(thread);
    return this.save({ ...thread, pinned }, 'thread.pinned');
  }

  /**
   * A title from the thread's first prompt and first answer: the driver's own
   * words when it has some (`titleSource: agent`), the first line of the
   * prompt otherwise (`prompt`). A driver that throws is one warning on the
   * log and the same fallback, never a failed call. Refused by name on a
   * thread with no prompt yet, or while an earlier ask is still running.
   */
  retitle(threadId: ThreadId): Promise<ThreadSummary> {
    return this.titles.retitle(threadId);
  }

  /** `automatic`: the core opens it by the `autoCompact` setting (`threads/auto-compact.ts`). */
  compact(threadId: ThreadId, expectedSelectionVersion?: number, automatic = false): Turn {
    const thread = this.require(threadId);
    const refusal = this.compactRefusal(thread);
    if (refusal !== null) throw refused(refusal, { threadId });
    const protocol = this.core.providers.require(thread.providerId).protocol;
    return this.startTurn(threadId, protocol === 'echo' ? '[compact]' : '/compact', [], expectedSelectionVersion, 'compact', undefined, undefined, automatic ? AUTO_COMPACT_LABEL : undefined);
  }

  /** Why this thread's agent cannot compact, or null. */
  compactRefusal(thread: ThreadSummary): string | null {
    const protocol = this.core.providers.require(thread.providerId).protocol;
    if (!thread.sessionId) return 'this thread has no native session to compact';
    if (protocol === 'acp' && !this.agentState.commands.get(thread.id)?.some((command) => command.name === 'compact')) {
      return 'this agent has not advertised a compact command';
    }
    // agy's print mode refuses every interactive-only slash command, `/compact` among them.
    if (protocol === 'agy') return 'the Antigravity CLI takes no /compact in print mode';
    return null;
  }

  /** Edit a sent message: it and everything after it leave the thread (`threads/branching.ts`). */
  rewind(threadId: ThreadId, messageId: MessageId): Promise<ThreadRewind> {
    return this.branching.rewind(threadId, messageId);
  }

  /** A new thread with the history up to and including a message (`threads/branching.ts`). */
  fork(threadId: ThreadId, messageId: MessageId, worktree: boolean): Promise<ThreadSummary> {
    return this.branching.fork(threadId, messageId, worktree);
  }

  /** Move a thread and its sub-threads to another project (`threads/move.ts`). */
  move(threadId: ThreadId, projectId: ProjectId, stopBackground?: boolean): Promise<ThreadSummary> {
    return this.moves.userMove(threadId, projectId, stopBackground);
  }

  startTurn(threadId: ThreadId, prompt: string, attachments: Attachment[] = [], expectedSelectionVersion?: number, operation?: NonNullable<Turn['execution']>['operation'], activity?: { kind: 'goal' | 'loop'; iteration: number }, clientRequestId?: string, displayText?: string, previewReferences: PreviewReference[] = [], agentRunId?: string, startedBy?: ThreadLink): Turn {
    if (this.core.stopping) throw refused('the core is stopping; reconnect before sending another prompt');
    const thread = this.require(threadId);
    this.codeCheckpoints.assertAvailable(thread.cwd);
    if (thread.agentSessionId && operation !== 'compact') {
      const run = agentRunId ? this.core.workforce.records.get('run', agentRunId) : null;
      if (!run || run.threadId !== threadId || run.status !== 'accepted' || run.id !== clientRequestId) throw refused('persistent agent sessions accept work through Agents, not turns.start');
    }
    checkAttachmentArray(attachments);
    const referenceError = previewReferencesError(previewReferences, prompt);
    if (referenceError) throw refused(referenceError);
    previewReferences = structuredClone(previewReferences);
    let fingerprint = '';
    if (clientRequestId !== undefined) {
      if (typeof clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(clientRequestId)) throw refused('clientRequestId must contain 8 to 128 URL-safe characters');
      fingerprint = createHash('sha256').update(JSON.stringify([prompt, attachments.map(a => [a.kind, a.mimeType, a.data, a.name]), ...(previewReferences.length ? [previewReferences] : [])])).digest('hex');
      const existing = this.core.journal.turnRequest(threadId, clientRequestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw refused('clientRequestId was already used for different content');
        const accepted = this.core.journal.getTurn(existing.turn_id);
        if (accepted) return accepted;
      }
    }
    this.checkSelection(thread, expectedSelectionVersion);
    if (thread.archived) throw refused('cannot start a turn on an archived thread', { threadId });
    if (['queued', 'running', 'waiting'].includes(thread.status) || this.runner.handles.has(threadId)) {
      const data: TurnInFlightData = { threadId, reason: 'turn-in-flight', thread: this.withLoad(thread) };
      throw refused('this thread already has an in-flight turn', data);
    }
    const provider = this.core.providers.require(thread.providerId);
    if (this.core.updates.updating(thread.providerId)) {
      throw refused(`${provider.name} is updating; send this again once it is done`, { threadId, providerId: thread.providerId });
    }
    assertDriverRunnable(
      provider.protocol,
      this.core.providers.summary(thread.providerId),
      this.core.accounts.require(thread.accountId),
      () => this.core.providers.launcherScriptOnly(thread.providerId),
    );
    checkStoredEffort(provider, thread.accountId, thread.model, thread.effort);
    checkSpeed(provider, thread.accountId, thread.model, thread.speed ?? null);
    checkAttachments(attachments, provider);

    // A compaction with a label is the core's own (`threads/auto-compact.ts`): Boite speaks, not the user.
    const automatic = operation === 'compact' && displayText !== undefined;
    const now = Date.now();
    // The first message after a move carries the note to the agent. A compact
    // or a slash command goes to the agent as the command alone, so the note
    // waits for the next real message.
    const moved = operation === 'compact' || prompt.trimStart().startsWith('/') ? null : pendingMove(this.core, threadId);
    const turn: Turn = {
      id: newId('trn_'),
      threadId,
      status: 'queued',
      queuedAt: now,
      startedAt: null,
      finishedAt: null,
      usage: null,
      error: null,
      execution: {
        providerId: thread.providerId, accountId: thread.accountId, model: thread.model,
        effort: thread.effort, speed: thread.speed ?? null, permissionMode: thread.permissionMode, sessionId: thread.sessionId,
        ...(thread.sessionId !== null && thread.sessionResumeAt ? { sessionResumeAt: thread.sessionResumeAt } : {}),
        sessionGeneration: thread.sessionGeneration ?? 0, selectionVersion: thread.selectionVersion ?? 0,
        ...(operation ? { operation } : {}),
        ...(automatic ? { automatic: true as const } : {}),
      },
    };
    const message: Message = {
      id: newId('msg_'),
      threadId,
      turnId: turn.id,
      role: systemOperation(operation) || automatic ? 'system' : 'user',
      parts: [
        { type: 'text', text: previewPrompt(prompt, previewReferences), ...(previewReferences.length ? { displayText: prompt, previewReferences } : {}), ...(systemOperation(operation) ? { displayText: displayText ?? SYSTEM_LABEL[operation] } : {}), ...(automatic ? { displayText } : {}), ...(activity ? { activity } : {}), ...(moved ? { moved } : {}), ...(startedBy ? { displayText: displayText ?? prompt, startedBy } : {}) },
        ...attachments.map((attachment): MessagePart => attachment.kind === 'file' ? { type: 'file', mimeType: attachment.mimeType, data: attachment.data, name: attachment.name } : ({
          type: 'image',
          mimeType: attachment.mimeType,
          data: attachment.data,
          alt: attachment.name,
        })),
      ],
      state: 'complete',
      createdAt: now,
    };

    // Accept the prompt and its queued status in one commit before starting the driver.
    this.core.bus.afterCommit(() => {
      const accepted = this.core.journal.db.transaction(() => {
        let reservation: (() => void) | undefined;
        this.core.journal.append({ type: 'turn.queued', threadId, version: 1, payload: turn }, () => {
          reservation = this.core.delegation.prepareTurnReservation(threadId, operation);
          this.core.journal.putTurn(turn);
          if (!operation && !nativeCommandPrompt(prompt)) this.deferred.recordHeldBeforePrompt(threadId, turn.id, now);
          this.core.journal.putMessage(message);
          if (moved) this.core.journal.deleteSetting(`${MOVE_NOTE_PREFIX}${threadId}`);
          if (clientRequestId) this.core.journal.putTurnRequest(threadId, clientRequestId, fingerprint, turn.id);
        });
        const dismissal = !activity && !operation ? this.core.activity.prepareUserPrompt(threadId) : undefined;
        this.core.bus.emit('message.started', message);
        this.core.bus.emit('message.completed', { threadId, messageId: message.id, state: 'complete' });
        this.setStatus(threadId, 'queued');
        return { reservation, dismissal };
      })();
      // Nothing in memory consumes the wake or resumes the agent until the prompt exists on disk.
      accepted.reservation?.();
      // A turn of the user's own, once accepted, takes whatever the agent wrote by itself first.
      if (operation !== 'background') this.deferred.pendingWakes.delete(threadId);
      accepted.dismissal?.();
      // His own message puts the agent back to work, so a pause left by Stop or a restart ends with it.
      if (!activity && !operation && !startedBy) this.core.coordination.resumeForUser(threadId);
    });
    this.autoCompact.cancel(threadId);
    this.core.scheduler.enqueue(turn, thread.accountId);
    return turn;
  }

  stopTurn(threadId: ThreadId): boolean {
    this.require(threadId);
    this.handoff.forget(threadId);
    this.core.coordination.pause(threadId);
    // Runs first: once they are stopped, a team with no child has nothing left to pause.
    const childrenStopped = this.core.workflows.stopRoot(threadId, 'Stopped with its thread') + this.core.delegation.stop(threadId);
    if (this.core.scheduler.stop(threadId) || childrenStopped > 0) return true;
    // No turn left, but the agent still runs work in the background: Stop ends
    // the agent process, and that work with it.
    if ((this.agentState.background.get(threadId)?.length ?? 0) === 0) return false;
    this.releaseAgent(threadId);
    this.agentState.noteBackground(threadId, []);
    return true;
  }

  /**
   * Ends the thread's agent process outside a turn (Stop on an idle thread, an
   * archive, an account switch, a stopped child agent, a provider update) and
   * sweeps what it leaves. A command the agent ran in the background survives
   * its exit, and with no `turn.finished` to follow nothing else would sweep it.
   */
  releaseAgent(threadId: ThreadId): void {
    releaseThread(threadId);
    this.core.procs.sweepSoon(threadId);
  }

  stopQueuedCoordination(threadId: ThreadId): boolean {
    const queued = this.core.journal.listTurns(threadId).find(turn => turn.status === 'queued' && turn.execution?.operation === 'coordination');
    return queued === undefined ? false : this.core.scheduler.stop(threadId);
  }

  canSteer(threadId: string): boolean { return typeof this.runner.handles.get(threadId)?.steer === 'function'; }

  async steer(threadId: string, text: string): Promise<boolean> {
    const handle = this.runner.handles.get(threadId);
    if (!handle?.steer || this.runner.steering.has(threadId)) return false;
    const turn = this.core.journal.listTurns(threadId).find(t => t.status === 'running');
    if (!turn) return false;
    this.runner.steering.add(threadId);
    try {
      const submitted = await handle.steer(text);
      if (submitted && !this.core.journal.isClosed()) this.noteCoordination(threadId, turn.id, text);
      return submitted;
    } finally {
      this.runner.steering.delete(threadId);
      void this.deferred.memory.flushRunning(threadId);
    }
  }

  noteCoordination(threadId: string, turnId: string, text: string): void {
    const message: Message = { id: newId('msg_'), threadId, turnId, role: 'system', parts: [{ type: 'text', text, displayText: 'Agent coordination' }], state: 'complete', createdAt: Date.now() };
    this.core.journal.append({ type: 'coordination.context', threadId, version: 1, payload: message }, () => this.core.journal.putMessage(message));
    this.core.bus.emit('message.started', message);
    this.core.bus.emit('message.completed', { threadId, messageId: message.id, state: 'complete' });
  }

  stopRunning(threadId: ThreadId): boolean {
    return this.runner.stopRunning(threadId);
  }

  markQueuedStopped(turnId: TurnId): void {
    const turn = this.core.journal.getTurn(turnId);
    if (turn === null) return;
    const next: Turn = { ...turn, status: 'stopped', finishedAt: Date.now() };
    this.core.bus.afterCommit(() => this.core.journal.db.transaction(() => {
      this.core.journal.append({ type: 'turn.stopped', threadId: turn.threadId, version: 1, payload: next }, () => {
        this.core.journal.putTurn(next);
      });
      this.core.bus.emit('turn.finished', next);
      this.setStatus(turn.threadId, 'idle');
    })());
    if (turn.execution?.operation === 'coordination') this.core.coordination.queuedCancelled(turn.threadId);
  }

  /** Closes the turns a stopped core left `running` or `queued` (`threads/recovery.ts`). */
  recoverStuckTurns(): number {
    return this.recovery.recoverStuckTurns();
  }

  runTurn(turnId: TurnId, threadId: ThreadId): Promise<void> {
    return this.runner.runTurn(turnId, threadId);
  }

  // -- cards (`threads/cards.ts`) ---------------------------------------------

  listPermissions(threadId?: ThreadId): PermissionRequest[] {
    return this.cards.listPermissions(threadId);
  }

  answerPermission(params: { requestId: RequestId; decision: 'allow' | 'deny' }): void {
    this.cards.answerPermission(params);
  }

  listQuestions(threadId?: ThreadId): QuestionRequest[] {
    return this.cards.listQuestions(threadId);
  }

  answerQuestion(params: { threadId: ThreadId; questionId: RequestId; optionIds: string[]; text?: string }): void {
    this.cards.answerQuestion(params);
  }

  skipQuestion(params: { threadId: ThreadId; questionId: RequestId }): void {
    this.cards.skipQuestion(params);
  }

  askAsync(params: { threadId: ThreadId; text: string; options?: string[]; multiple?: boolean }): { questionId: RequestId } {
    return this.cards.askAsync(params);
  }

  // -- internals ------------------------------------------------------------

  private setStatus(threadId: ThreadId, status: ThreadStatus): void {
    setThreadStatus(this.core, threadId, status);
  }

  private save(thread: ThreadSummary, eventType: string): ThreadSummary {
    return saveThread(this.core, thread, eventType);
  }

  private withLoad(thread: ThreadSummary): ThreadSummary {
    return withLoad(this.core, thread);
  }
}
