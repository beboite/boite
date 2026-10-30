import { archiveState, archiveStateKey } from './merged-pr-archive-state.ts';
import { assertIdleFamily } from './threads/completion.ts';
import { repositoryOf, type MergedPrProof } from './pull-requests.ts';
import { previewReferencesError, previewPrompt, threadActive, DEFAULT_THREAD_DELETION_RETENTION_DAYS, type AgentProfile } from '@boite/contracts';
import type {
  Account, AccountId, Attachment,
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
  ThreadSummary,
  Turn,
  TurnId,
  TurnInFlightData,
} from '@boite/contracts';
import type { Core } from './core.ts';
import { notFound, refused } from './errors.ts';
import { newId } from './ids.ts';
import { assertDriverRunnable, releaseThread } from './drivers/index.ts';
import { AgentState } from './threads/agent-state.ts';
import { ThreadBranching } from './threads/branching.ts';
import { CodeCheckpoints } from './threads/code-checkpoints.ts';
import { ThreadCards } from './threads/cards.ts';
import { AUTO_COMPACT_LABEL, AutoCompaction } from './threads/auto-compact.ts';
import { BackgroundCompaction } from './threads/background-compact.ts';
import { CacheKeepalive } from './threads/cache-keepalive.ts';
import { DeferredInput } from './threads/deferred.ts';
import { MOVE_NOTE_PREFIX, pendingMove, ThreadMove } from './threads/move.ts';
import { ThreadSpawns } from './threads/spawn.ts';
import { checkAttachmentArray, checkAttachments, checkTurnRequest, titleOf } from './threads/inputs.ts';
import { RestartHandoff } from './threads/handoff.ts';
import { SYSTEM_LABEL, nativeCommandPrompt, systemOperation } from './threads/operations.ts';
import { USER_ORIGIN, autonomousSource, originAutomatic, originOperation, type StartTurnOptions, type TurnInput, type TurnOrigin } from './threads/turn-origin.ts';
import { saveThread, withLoad } from './threads/records.ts';
import { isBusy, markQueued } from './threads/lifecycle.ts';
import { admissionRefusal } from './threads/admission.ts';
import { ThreadRecovery } from './threads/recovery.ts';
import { LimitResumes } from './threads/limit-resume.ts';
import { AutoContinues } from './threads/auto-continue.ts';
import { ResumePlanner } from './threads/resume.ts';
import { ThreadTitles } from './threads/retitle.ts';
import { SideQuestions } from './threads/side-questions.ts';
import { messagePage, threadSnapshot, type MessagePage } from './threads/snapshot.ts';
import { checkEffort, checkModel, checkSpeed, checkStoredEffort, checkStoredSpeed, defaultModel } from './threads/selection.ts';
import { TurnContexts } from './threads/turn-context.ts';
import { TurnRunner } from './threads/turn-runner.ts';
import { markQueuedStopped } from './threads/turn-settlement.ts';
import { ThreadFocus } from './threads/focus.ts';
import { ThreadListLog } from './threads/list-changes.ts';
import { ProgressState } from './threads/progress.ts';
import { eraseIncognito } from './threads/incognito.ts';
import { removeTranscripts, threadSessions, type NativeSession } from './threads/transcript-purge.ts';
import { ThreadCreation } from './threads/creation.ts';
import { accountRemoved, followAgent } from './threads/account-fallback.ts';
import { requireAgent } from './threads/agentless.ts';

type CreateParams = RpcParams<'threads.create'>;

/**
 * The threads of this core: what the RPC and the other modules call. Each part
 * under `threads/` owns its own state; the store builds them and hands them
 * itself, so a part reaches another through it.
 */
export class ThreadStore {
  /** Internal-only entry: callers supply an already authorized workspace, never a fabricated project. */
  createAgentSession(agent: AgentProfile, sessionId: string, cwd: string, projectId: string | null = null, branch: string | null = null): ThreadSummary {
    // Opening its conversation must also work after a provider or account was
    // removed, so the owner can read it and repair its route in Settings.
    // Profile saves and turn admission validate the route before it can run.
    const now = Date.now();
    const thread: ThreadSummary = {
      id: newId('thr_'), projectId, agentSessionId: sessionId, title: agent.name, titleSource: 'user',
      ...agent.selection, speed: null, cwd, branch, status: 'idle', unread: false, archived: false, pinned: false,
      sessionId: null, sessionGeneration: 0, selectionVersion: 0, load: null, context: null, createdAt: now, updatedAt: now,
    };
    this.#core.journal.append({ type: 'thread.created', threadId: thread.id, version: 1, payload: thread }, () => this.#core.journal.putThread(thread));
    return thread;
  }

  /** Runs each turn and owns the handles of the running ones. */
  readonly runner: TurnRunner;
  /** Builds what a driver gets for a turn. */
  readonly contexts: TurnContexts;
  readonly focus: ThreadFocus;
  readonly creation: ThreadCreation;
  readonly progress: ProgressState;
  /** Permission and question cards. */
  readonly cards: ThreadCards;
  /** Held asynchronous answers and wakes. */
  readonly deferred: DeferredInput;
  /** Commands, background tasks and context the agent reported. */
  readonly agentState: AgentState;
  readonly titles: ThreadTitles;
  readonly sideQuestions: SideQuestions;
  /** `threads.rewind` and `threads.fork`. */
  readonly branching: ThreadBranching;
  readonly codeCheckpoints: CodeCheckpoints;
  /** `threads.move`. */
  readonly moves: ThreadMove;
  /** `agent.spawn`. */
  readonly spawns: ThreadSpawns;
  /** The `autoCompact` setting: compactions the core opens between turns. */
  readonly autoCompact: AutoCompaction;
  /** The experimental `backgroundCompaction` setting: copies compacted ahead of the limit. */
  readonly backgroundCompact: BackgroundCompaction;
  /** The `cacheKeepalive` setting: pings that keep a waiting thread's prompt cache warm. */
  readonly cacheKeepalive: CacheKeepalive;
  /** Every resume the core plans by itself, whatever stopped the turn (`threads/resume.ts`). */
  readonly resumes: ResumePlanner;
  /** Threads a usage limit stopped, resumed once its window resets (`threads/limit-resume.ts`). */
  readonly limitResumes: LimitResumes;
  /** Turns stopped before their answer, resumed by themselves (`threads/auto-continue.ts`). */
  readonly autoContinue: AutoContinues;
  readonly #recovery: ThreadRecovery;
  /** Turns a restart hands to the next core (`threads/handoff.ts`). */
  readonly handoff: RestartHandoff;
  /** `threads.listChanges`: the threads changed since a client's last list. */
  readonly listLog: ThreadListLog;
  readonly #removing = new Set<ThreadId>();
  /** The last purge's removal of native transcripts (`threads/transcript-purge.ts`), which tests wait for. */
  transcriptPurge: Promise<string[]> = Promise.resolve([]);

  readonly #core: Core;

  constructor(core: Core) { this.#core = core;
    this.runner = new TurnRunner(core, this);
    this.contexts = new TurnContexts(core, this);
    this.focus = new ThreadFocus(core);
    this.creation = new ThreadCreation(core);
    this.progress = new ProgressState(core);
    this.cards = new ThreadCards(core, this);
    this.deferred = new DeferredInput(core, this);
    this.agentState = new AgentState(core);
    this.titles = new ThreadTitles(core, this);
    this.sideQuestions = new SideQuestions(core, this);
    this.branching = new ThreadBranching(core, this);
    this.codeCheckpoints = new CodeCheckpoints(core);
    this.moves = new ThreadMove(core, this);
    this.spawns = new ThreadSpawns(core, this);
    this.autoCompact = new AutoCompaction(core, this);
    this.backgroundCompact = new BackgroundCompaction(core, this);
    this.cacheKeepalive = new CacheKeepalive(core, this);
    this.resumes = new ResumePlanner(core, this);
    this.limitResumes = new LimitResumes(core, this.resumes);
    this.autoContinue = new AutoContinues(core, this, this.resumes);
    this.#recovery = new ThreadRecovery(core);
    this.handoff = new RestartHandoff(core, this);
    this.listLog = new ThreadListLog(core);
  }

  // -- reads ----------------------------------------------------------------

  list(params: { projectId?: ThreadId; includeArchived?: boolean }): ThreadSummary[] {
    const threads = this.#core.journal.listThreads(params.projectId);
    // Archived rows are most of a long-lived journal: only the ones answered get their live state.
    const shown = params.includeArchived === true ? threads : threads.filter((thread) => !thread.archived);
    return shown.map((thread) => this.#withLoad(thread));
  }

  require(threadId: ThreadId): ThreadSummary {
    const thread = this.#core.journal.getThread(threadId);
    if (thread === null) throw notFound(`unknown thread ${threadId}`, { threadId });
    return thread;
  }

  /**
   * The thread with its last page of messages. A thousand-message thread costs
   * one page here; the rest is walked back through `messages`, whose cursor is
   * `messagesBefore`.
   */
  get(threadId: ThreadId, after?: MessageId, options: Pick<RpcParams<'threads.get'>, 'limit' | 'maxBytes' | 'compactTools' | 'compactFiles' | 'compactImages' | 'compactToolParts' | 'around' | 'sync' | 'open'> = {}): Thread {
    return threadSnapshot(this.#core, this.#withLoad(this.require(threadId)), after, options, this.agentState);
  }

  /**
   * One page of messages older than `before`, oldest first inside the page, or
   * newer than `after`. An unknown thread is a not-found; a cursor that is not
   * a message of that thread is refused by name rather than answered with an
   * empty page, and so is a call with both cursors or neither.
   */
  messages(params: RpcParams<'messages.list'>): MessagePage {
    this.require(params.threadId);
    return messagePage(this.#core, params);
  }

  // -- writes ---------------------------------------------------------------

  createInWorktree(params: CreateParams): Promise<ThreadSummary> { return this.creation.createInWorktree(params); }
  create(params: CreateParams, placed?: { id: ThreadId; branch: string | null; branchNamingPending?: boolean; parentThreadId?: ThreadId }): ThreadSummary {
    return this.creation.create(params, placed);
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
      /** The transcript's last model is historical state, independent of a fresh catalog. */
      model: string | null;
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
    const { project, provider, account } = this.#check(params);
    const now = Date.now();
    const first = history.turns[0];
    const last = history.turns[history.turns.length - 1];
    const model = history.model ?? checkModel(provider, account.id, params.model ?? defaultModel(provider));
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
    this.#core.journal.append({ type: 'thread.imported', threadId: thread.id, version: 1, payload: thread }, () => {
      this.#core.journal.putThread(thread);
      for (const row of rows) {
        this.#core.journal.putTurn(row.turn);
        for (const message of row.messages) this.#core.journal.putMessage(message);
      }
    });
    this.#core.bus.emit('thread.created', thread);
    return thread;
  }

  /** The project, provider and account a new thread names, each refused by name when wrong. */
  #check(params: CreateParams): { project: Project; provider: ProviderDescriptor; account: Account } { return this.creation.check(params); }

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
    this.#checkSelection(thread, params.expectedSelectionVersion);
    const next: ThreadSummary = { ...thread };
    // A title the user typed is theirs: no turn and no retitle overwrites it unasked.
    if (params.title !== undefined && params.title.length > 0) {
      next.title = params.title;
      next.titleSource = 'user';
      next.titleState = { version: (thread.titleState?.version ?? 0) + 1, needsRefinement: false };
    }
    if (params.accountId === undefined && this.#core.journal.getAccount(thread.accountId) === null) {
      // The account was removed: the title and the mode still change, a model needs another account first.
      if (params.model !== undefined || params.effort !== undefined || params.speed !== undefined) throw accountRemoved(thread);
      if (params.permissionMode !== undefined) next.permissionMode = params.permissionMode;
      const modeChanged = next.permissionMode !== thread.permissionMode;
      if (modeChanged) next.selectionVersion = (thread.selectionVersion ?? 0) + 1;
      const saved = this.#save(next, 'thread.updated');
      if (modeChanged) this.runner.changePermissionMode(thread.id, next.permissionMode, thread, next);
      return saved;
    }
    const account = this.#core.accounts.require(params.accountId ?? thread.accountId);
    const switched = account.id !== thread.accountId;
    const provider = this.#core.providers.require(account.providerId);
    if (switched) {
      assertDriverRunnable(provider.protocol, this.#core.providers.summary(provider.id), account, () => this.#core.providers.launcherScriptOnly(provider.id));
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
    const changedModel = switched || next.model !== thread.model;
    if (changedModel || next.speed !== thread.speed) next.speed = checkSpeed(provider, account.id, next.model, next.speed ?? null);
    // The model may have changed in the same call, so the scale is the new one's.
    if (changedModel || next.effort !== thread.effort) next.effort = checkEffort(provider, account.id, next.model, next.effort);
    if (switched || next.model !== thread.model || next.effort !== thread.effort || next.speed !== thread.speed || next.permissionMode !== thread.permissionMode) {
      next.selectionVersion = (thread.selectionVersion ?? 0) + 1;
    }
    if (switched) {
      this.agentState.cancelBackground(thread.id);
      if (!threadActive(thread.status)) {
        this.releaseAgent(thread.id);
        this.agentState.noteBackground(thread.id, []);
      }
      this.agentState.commands.delete(thread.id);
      this.#core.bus.emit('thread.commands', { threadId: thread.id, commands: [] });
    }
    const saved = this.#save(next, 'thread.updated');
    this.runner.selectionChanged(thread, next);
    return saved;
  }

  #checkSelection(thread: ThreadSummary, expected?: number): void {
    if (expected !== undefined && expected !== (thread.selectionVersion ?? 0)) {
      throw refused('the model selection changed; review the selected model and send again', { threadId: thread.id });
    }
  }

  isRemoving(threadId: ThreadId): boolean { return this.#removing.has(threadId); }

  /** Automatic Done changes visibility only, retaining the checkout and any prompt still finishing. */
  archiveMergedPr(expected: ThreadSummary, proof: MergedPrProof, generation: number, detected = false): ThreadSummary | null {
    const thread = this.#core.journal.getThread(expected.id);
    const state = archiveState(this.#core.journal, expected.id);
    const project = thread?.projectId ? this.#core.journal.getProject(thread.projectId) : null;
    if (!thread || !project || repositoryOf(thread.cwd) !== proof.checkoutRepository || repositoryOf(project.path) !== proof.checkoutRepository) return null;
    if ((!detected && thread.updatedAt !== expected.updatedAt) || thread.cwd !== expected.cwd || thread.branch !== expected.branch || thread.projectId !== expected.projectId || state.generation !== generation || state.dismissed?.includes(proof.url) || !this.#core.mergedPrArchive.eligible(thread, detected)) return null;
    const archivedThread = this.#core.bus.afterCommit(() => this.#core.journal.db.transaction(() => {
      this.#core.journal.setSetting(archiveStateKey(thread.id), { ...state, binding: proof, reason: { type: 'pr-merged', number: proof.number, url: proof.url, archivedAt: Date.now() } });
      const now = Date.now();
      const saved = this.#save({ ...thread, archived: true, doneAt: now, archivedAt: now }, 'thread.archived');
      if (thread.projectId !== null) this.#core.projects.announce(thread.projectId);
      return saved;
    })());
    if (archivedThread) {
      this.autoCompact.stopIfDone(thread.id);
      this.#core.fileTickets.forgetUnder(thread.cwd);
    }
    return archivedThread;
  }

  /** Turning off the project filter reveals its automatic hides without dismissing the PR. */
  showMergedPrThreads(projectId: ProjectId): void {
    for (const thread of this.#core.journal.listThreads(projectId)) {
      if (!thread.archived || thread.parentThreadId || this.isRemoving(thread.id) || this.#core.worktrees.reservations.holder(thread.cwd) !== null) continue;
      const state = archiveState(this.#core.journal, thread.id);
      if (state.reason?.type !== 'pr-merged') continue;
      this.#core.journal.setSetting(archiveStateKey(thread.id), { ...state, reason: undefined, generation: state.generation + 1 });
      this.#save({ ...thread, archived: false, doneAt: null, archivedAt: null }, 'thread.archived');
    }
  }

  archive(threadId: ThreadId, archived: boolean, onlyIfIdle = false): ThreadSummary {
    this.require(threadId);
    if (archived && onlyIfIdle) assertIdleFamily(this.#core, threadId, 'explicit');
    if (!archived && this.#removing.has(threadId)) throw refused('threadId: this conversation is being deleted', { threadId, field: 'threadId', expected: 'a conversation not being deleted' });
    const thread = this.require(threadId);
    // A subagent reopened by hand is not put away again for the work it already finished.
    if (!archived && thread.archived && thread.parentThreadId) this.#core.delegation.retirements.keep(threadId);
    const saved = this.#core.bus.afterCommit(() => this.#core.journal.db.transaction(() => {
      if (!archived) {
        const state = archiveState(this.#core.journal, threadId);
        const dismissed = [...new Set([...(state.dismissed ?? []), ...(state.binding ? [state.binding.url] : [])])];
        this.#core.journal.setSetting(archiveStateKey(threadId), { ...state, reason: undefined, generation: state.generation + 1, dismissed, restoredCheckout: { projectId: thread.projectId, cwd: thread.cwd, branch: thread.branch } });
      } else {
        const state = archiveState(this.#core.journal, threadId);
        if (state.reason) this.#core.journal.setSetting(archiveStateKey(threadId), { ...state, reason: undefined, generation: state.generation + 1 });
      }
      // Keep deletion retryable until staging commits its tombstone and clears this date.
      const doneAt = archived && (onlyIfIdle || this.#removing.has(threadId)) ? thread.doneAt ?? (onlyIfIdle ? Date.now() : null) : null;
      // Archiving an archived thread again keeps its time: nothing new was put away.
      const archivedAt = archived ? (thread.archived ? thread.archivedAt ?? null : Date.now()) : null;
      const saved = this.#save({ ...thread, archived, doneAt, archivedAt }, 'thread.archived');
      const projectThread = !thread.parentThreadId || this.#core.journal.getThread(thread.parentThreadId)?.agentSessionId;
      if ((thread.archived !== archived || (thread.doneAt ?? null) !== doneAt) && projectThread && thread.projectId !== null) this.#core.projects.announce(thread.projectId);
      if (archived) this.#core.bus.whenCommitted(() => this.#putAway(threadId, thread.cwd));
      return saved;
    })());
    return saved;
  }

  /** What a committed archive stops: its warm process and what it listed go now. One that rolls back stops nothing. */
  #putAway(threadId: ThreadId, cwd: string): void {
    // Temporary inference belongs to the visible family, including retained descendants.
    const family = this.#core.journal.db.query('WITH RECURSIVE family(id) AS (SELECT ? UNION SELECT child.id FROM threads child JOIN family ON child.parent_thread_id = family.id) SELECT id FROM family').all(threadId) as { id: ThreadId }[];
    for (const member of family) this.sideQuestions.cancel(member.id);
    this.moves.forget(threadId);
    this.#core.delegation.stop(threadId);
    this.#core.scheduler.stop(threadId);
    this.releaseAgent(threadId);
    this.agentState.commands.delete(threadId);
    this.agentState.noteBackground(threadId, []);
    // Nobody answers a card on a thread put away, and no turn should start from one.
    this.cards.clearQuestionsOf(threadId, true, 'archive');
    for (const pending of [this.deferred.deferredAnswers, this.deferred.consumed, this.deferred.pendingWakes]) pending.delete(threadId);
    void this.#core.terminals.closeThread(threadId);
    // A removal waits for the same stops itself before it hides the family.
    if (!this.#removing.has(threadId)) void this.#endArchivedWork(threadId);
    this.#core.fileTickets.forgetUnder(cwd);
  }

  /**
   * Stopping the turn asks the agent to stop; what it started (a dev server, a
   * background shell, a build) has no turn left to end it and would run on
   * behind a thread nobody sees. Once the stopped turns have settled, the
   * processes of the thread and of its sub-threads go. A thread restored in
   * the meantime, or a sub-thread given new work, keeps its own.
   */
  async #endArchivedWork(threadId: ThreadId): Promise<void> {
    try {
      const family = this.#core.journal.listThreads().filter(t => t.id === threadId || t.parentThreadId === threadId).map(t => t.id);
      await Promise.all(family.map(id => this.#core.scheduler.stopAndWait(id)));
      if (this.#core.stopping || this.#core.journal.isClosed() || this.#removing.has(threadId)) return;
      if (this.#core.journal.getThread(threadId)?.archived !== true) return;
      const idle = family.filter((id) => {
        const member = this.#core.journal.getThread(id);
        return member !== null && !threadActive(member.status);
      });
      await Promise.all(idle.map(id => this.#core.procs.stopAndWait(id)));
    } catch (error) {
      this.#core.log('warn', `archived thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  markRead(threadId: ThreadId): void {
    const thread = this.require(threadId);
    if (!thread.unread) return;
    this.#save({ ...thread, unread: false }, 'thread.read');
  }

  async remove(threadId: ThreadId): Promise<void> {
    const root = this.require(threadId);
    if (root.agentSessionId || root.parentThreadId) {
      throw refused('threadId: delete a conversation from its parent; a bot\'s thread goes when the bot is archived', { threadId, field: 'threadId', expected: 'a top-level conversation without agentSessionId' });
    }
    if (this.#removing.has(threadId)) throw refused('threadId: this conversation is already being deleted', { threadId, field: 'threadId', expected: 'a conversation not being deleted' });
    const family = this.#core.journal.listThreads().filter(t => t.id === threadId || t.parentThreadId === threadId);
    for (const thread of family) this.#removing.add(thread.id);
    try {
      // One write hides the family; until it commits, its runs and steps go on.
      this.#core.bus.afterCommit(() => this.#core.journal.db.transaction(() => { for (const thread of family) this.archive(thread.id, true); })());
      this.#core.workflows.stopRoot(threadId, 'Conversation deleted');
      await Promise.all(family.map(thread => this.#core.scheduler.stopAndWait(thread.id)));
      await Promise.all(family.flatMap(thread => [
        this.#core.procs.stopAndWait(thread.id),
        this.#core.terminals.stopThread(thread.id),
      ]));
      const ids = family.map(thread => thread.id);
      if (root.incognito) return await eraseIncognito(this.#core, root, ids);
      this.#core.journal.append(
        { type: 'thread.removed', threadId: null, version: 1, payload: { threadIds: ids } },
        () => this.#core.journal.stageThreadDeletion(threadId, family),
      );
      for (const id of ids) this.#core.bus.emit('thread.removed', { threadId: id, undoable: true });
      this.#core.bus.emit('thread.deletionsUpdated', {});
      if (root.projectId !== null && this.#core.journal.getProject(root.projectId)) this.#core.projects.announce(root.projectId);
    } finally {
      for (const thread of family) this.#removing.delete(thread.id);
    }
  }

  restoreDeleted(threadId: ThreadId): ThreadSummary {
    this.purgeDeleted();
    const root = this.#core.journal.listDeletedThreads().find(t => t.id === threadId);
    if (!root) throw notFound(`threadId: no recoverable deletion for ${threadId}`, { threadId });
    if (root.projectId !== null) this.#core.projects.require(root.projectId);
    const ids = this.#core.journal.append(
      { type: 'thread.restored', threadId, version: 1, payload: { threadId } },
      () => this.#core.journal.restoreDeletedThreads(threadId),
    );
    for (const id of ids) this.#core.bus.emit('thread.created', this.#withLoad(this.require(id)));
    this.#core.bus.emit('thread.deletionsUpdated', {});
    if (root.projectId !== null) this.#core.projects.announce(root.projectId);
    return this.#withLoad(this.require(threadId));
  }

  /** Expiry uses the deletion date, never the conversation's creation or last message. */
  purgeDeleted(): void {
    const days = this.#core.settings.get().threadDeletionRetentionDays ?? DEFAULT_THREAD_DELETION_RETENTION_DAYS;
    if (days === 0) return;
    let sessions: NativeSession[] = [];
    const purged = this.#core.journal.purgeDeletedThreads(Date.now() - days * 86_400_000, ids => {
      sessions = threadSessions(this.#core.journal.db, ids);
    });
    if (purged > 0) {
      this.#core.bus.emit('thread.deletionsUpdated', {});
      this.transcriptPurge = removeTranscripts(this.#core, sessions);
    }
  }

  pin(threadId: ThreadId, pinned: boolean): ThreadSummary {
    const thread = this.require(threadId);
    // Pinning twice is not a change: no journal row, no event, the same summary back.
    if (thread.pinned === pinned) return this.#withLoad(thread);
    return this.#save({ ...thread, pinned }, 'thread.pinned');
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
    const thread = requireAgent(this, threadId);
    const refusal = this.compactRefusal(thread);
    if (refusal !== null) throw refused(refusal, { threadId });
    const protocol = this.#core.providers.require(thread.providerId).protocol;
    return this.startTurn(threadId, { prompt: protocol === 'echo' ? '[compact]' : '/compact', ...(automatic ? { display: AUTO_COMPACT_LABEL } : {}) }, { kind: 'compact', automatic }, { expectedSelectionVersion });
  }

  /** Why this thread's agent cannot compact, or null. */
  compactRefusal(thread: ThreadSummary): string | null {
    // A provider Boite no longer has, `providers/retired.ts`, runs nothing: there is nothing to compact.
    const protocol = this.#core.providers.get(thread.providerId)?.protocol;
    if (protocol === undefined) return 'this thread\'s provider is not installed';
    if (!thread.sessionId) return 'this thread has no native session to compact';
    if (protocol === 'acp' && !this.agentState.commands.get(thread.id)?.some((command) => command.name === 'compact')) {
      return 'this agent has not advertised a compact command';
    }
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

  /** Accepts a turn and queues it (`threads/turn-origin.ts`): `origin` says who starts it and why. */
  startTurn(threadId: ThreadId, input: string | TurnInput, origin: TurnOrigin = USER_ORIGIN, options: StartTurnOptions = {}): Turn {
    let { prompt, attachments = [], previews: previewReferences = [], display: displayText } = typeof input === 'string' ? { prompt: input } : input;
    const { expectedSelectionVersion, persistAdmission, choice: executionChoice, autoGoal } = options;
    const operation = originOperation(origin), automatic = originAutomatic(origin);
    const clientRequestId = origin.requestId;
    const activity = origin.kind === 'goal' ? origin.activity : undefined;
    const startedBy = origin.kind === 'spawned' ? origin.startedBy : undefined;
    const sentFrom = origin.kind === 'user' ? origin.sentFrom ?? null : null;
    if (this.#core.stopping) throw refused('the core is stopping; reconnect before sending another prompt');
    let thread = requireAgent(this, threadId);
    this.codeCheckpoints.assertAvailable(thread.cwd);
    checkAttachmentArray(attachments);
    const referenceError = previewReferencesError(previewReferences, prompt);
    if (referenceError) throw refused(referenceError);
    previewReferences = structuredClone(previewReferences);
    const { fingerprint, turn: accepted } = checkTurnRequest(this.#core.journal, threadId, prompt, attachments, previewReferences, clientRequestId);
    if (accepted) return accepted;
    this.#checkSelection(thread, expectedSelectionVersion);
    const refusal = admissionRefusal(this.#core, thread, executionChoice);
    if (refusal !== null) throw refused(refusal, { threadId });
    if (this.isBusy(threadId)) {
      const data: TurnInFlightData = { threadId, reason: 'turn-in-flight', thread: this.#withLoad(thread) };
      throw refused('this thread already has an in-flight turn', data);
    }
    // A turn the core starts by itself on a persistent agent's thread meets the agent's pause and budget first.
    const autonomous = autonomousSource(origin);
    if (autonomous !== null) this.#core.agentRuntime.admit(thread, autonomous);
    // A signed-out or removed account hands the thread to another of its agent (`threads/account-fallback.ts`).
    if (executionChoice) {
      const provider = this.#core.providers.require(executionChoice.providerId);
      const account = this.#core.accounts.require(executionChoice.accountId);
      const model = checkModel(provider, account.id, executionChoice.model);
      const sameAccount = thread.providerId === provider.id && thread.accountId === account.id;
      thread = { ...thread, providerId: provider.id, accountId: account.id, model,
        effort: checkEffort(provider, account.id, model, executionChoice.effort), speed: checkSpeed(provider, account.id, model, executionChoice.speed ?? null),
        ...(!sameAccount ? { sessionId: null, sessionResumeAt: null } : {}) };
    } else thread = followAgent(this.#core, thread);
    this.#core.sharedCompute?.assertTurn(threadId);
    this.#core.sharedAccess?.assertTurn(threadId);
    const provider = this.#core.providers.require(thread.providerId);
    const account = this.#core.accounts.require(thread.accountId);
    if (account.providerId !== provider.id) throw refused(`accountId: account ${account.id} belongs to provider ${account.providerId}; expected provider ${provider.id}`, {
      field: 'accountId', accountId: account.id, providerId: account.providerId, expected: provider.id,
    });
    assertDriverRunnable(
      provider.protocol,
      this.#core.providers.summary(thread.providerId),
      account,
      () => this.#core.providers.launcherScriptOnly(thread.providerId),
    );
    checkStoredEffort(provider, thread.accountId, thread.model, thread.effort);
    checkStoredSpeed(provider, thread.accountId, thread.model, thread.speed ?? null);
    checkAttachments(attachments, provider);
    this.#core.sharedAccess.uploads(threadId, attachments);

    if (!operation && !activity && !startedBy) {
      const expanded = this.#core.brain.expandPrompt(prompt, this.agentState.commands.get(threadId));
      const offset = expanded.length - prompt.length;
      if (expanded !== prompt) {
        previewReferences = previewReferences.map(reference => reference.mention ? {
          ...reference, mention: { start: reference.mention.start + offset, end: reference.mention.end + offset },
        } : reference);
        prompt = expanded;
      }
    }

    const now = Date.now();
    // The first message after a move carries the note to the agent. A compact,
    // a keepalive or a slash command goes to the agent as the command alone, so
    // the note waits for the next real message.
    const moved = operation === 'compact' || operation === 'keepalive' || prompt.trimStart().startsWith('/') ? null : pendingMove(this.#core, threadId);
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
        ...(thread.sessionId !== null && thread.sessionResumeAt ? { sessionResumeAt: thread.sessionResumeAt } : executionChoice ? { sessionResumeAt: null } : {}),
        sessionGeneration: thread.sessionGeneration ?? 0, selectionVersion: thread.selectionVersion ?? 0,
        ...(executionChoice ? { frozenSelection: true as const } : {}),
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
        { type: 'text', text: previewPrompt(prompt, previewReferences), ...(previewReferences.length ? { displayText: prompt, previewReferences } : {}), ...(systemOperation(operation) ? { displayText: displayText ?? SYSTEM_LABEL[operation] } : {}), ...(automatic ? { displayText } : {}), ...(activity ? { activity } : {}), ...(moved ? { moved } : {}), ...(startedBy ? { displayText: displayText ?? prompt, startedBy } : {}), ...(sentFrom && !operation ? { sentFrom } : {}) },
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
    this.#core.bus.afterCommit(() => {
      const accepted = this.#core.journal.db.transaction(() => {
        let reservation: (() => void) | undefined, admitted: (() => void) | undefined;
        this.#core.journal.append({ type: 'turn.queued', threadId, version: 1, payload: turn }, () => {
          reservation = this.#core.delegation.prepareTurnReservation(threadId, operation);
          this.#core.journal.putTurn(turn);
          if (!operation && !nativeCommandPrompt(prompt)) this.deferred.recordHeldBeforePrompt(threadId, turn.id, now);
          this.#core.journal.putMessage(message);
          if (moved) this.#core.journal.deleteSetting(`${MOVE_NOTE_PREFIX}${threadId}`);
          if (clientRequestId) this.#core.journal.putTurnRequest(threadId, clientRequestId, fingerprint, turn.id, message.id);
          admitted = persistAdmission?.();
        });
        const dismissal = !activity && !operation ? this.#core.activity.prepareUserPrompt(threadId, !nativeCommandPrompt(prompt)) : undefined;
        this.#core.bus.emit('message.started', message);
        this.#core.bus.emit('message.completed', { threadId, messageId: message.id, state: 'complete' });
        // A status that stays queued tells nobody: the row still loses its pending move note.
        if (moved && this.#core.journal.getThread(threadId)?.status === 'queued') this.#core.bus.emit('thread.updated', this.#withLoad(this.require(threadId)));
        markQueued(this.#core, threadId);
        return { reservation, dismissal, admitted };
      })();
      // Nothing in memory consumes the wake or resumes the agent until the prompt exists on disk.
      accepted.admitted?.();
      accepted.reservation?.();
      // A turn of the user's own, once accepted, takes whatever the agent wrote by itself first; a keepalive leaves it for the next.
      if (operation !== 'background' && operation !== 'keepalive') this.deferred.pendingWakes.delete(threadId);
      accepted.dismissal?.();
      // His own message, a resume or a parent's message to its subagent puts the agent back to work,
      // so a pause the core left on Stop, a failure or a restart ends with it; the owner's stays.
      if (!activity && !startedBy && (!operation || operation === 'resume' || (operation === 'delegation' && thread.parentThreadId))) this.#core.coordination.resumeForUser(threadId);
      // `autoGoal`, the prompt as typed, may start an automatic goal (`docs/goals.md`); otherwise a `/goal2`'s checklist reads what the user adds, drops or changes.
      if (!activity && !operation && !startedBy && !nativeCommandPrompt(prompt) && !(autoGoal !== undefined && this.#core.activity.autoGoal(threadId, turn.id, message.id, autoGoal, executionChoice))) this.#core.activity.userMessage(threadId, prompt);
    });
    this.autoCompact.cancel(threadId);
    this.cacheKeepalive.cancel(threadId);
    this.#core.scheduler.enqueue(turn, thread.accountId);
    return turn;
  }

  /** True while a turn of the thread is under way (`threads/lifecycle.ts`). */
  isBusy(threadId: ThreadId): boolean {
    return isBusy(this.#core, threadId);
  }

  /**
   * Cancels what the core planned to try again on the thread: a capacity retry
   * its turn waits for, which then fails with the refusal, a resume after a
   * usage limit, or an automatic resume. False when nothing was planned.
   */
  cancelRetry(threadId: ThreadId): boolean {
    this.require(threadId);
    return this.runner.cancelRetry(threadId) || this.resumes.cancel(threadId, 'cancelled by the user');
  }

  stopTurn(threadId: ThreadId): boolean {
    this.require(threadId);
    this.handoff.forget(threadId);
    this.cacheKeepalive.forget(threadId);
    // Stop on a thread waiting for a usage limit to reset means: do not resume it.
    const plannedResume = this.resumes.cancel(threadId, 'the thread was stopped');
    this.#core.coordination.pause(threadId);
    // Runs first: once they are stopped, a team with no child has nothing left to pause.
    const childrenStopped = this.#core.workflows.stopRoot(threadId, 'Stopped with its thread') + this.#core.delegation.stop(threadId);
    if (this.#core.scheduler.stop(threadId) || childrenStopped > 0) return true;
    // No turn left, but the agent still runs work in the background: Stop ends
    // the agent process, and that work with it.
    if ((this.agentState.background.get(threadId)?.length ?? 0) === 0) return plannedResume;
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
    void this.#core.procs.protection.revoke(threadId).catch(() => {});
    this.agentState.cancelBackground(threadId);
    releaseThread(threadId);
    this.#core.procs.sweepSoon(threadId);
  }

  stopQueuedCoordination(threadId: ThreadId): boolean {
    return this.#core.journal.queuedTurn(threadId, 'coordination') === null ? false : this.#core.scheduler.stop(threadId);
  }

  /** Maintenance takes no steering: results remain in their inbox until the next conversation turn. */
  canSteer(threadId: string): boolean {
    const operation = this.#core.journal.lastTurn(threadId)?.execution?.operation;
    return typeof this.runner.handles.get(threadId)?.steer === 'function' && operation !== 'compact' && !this.cacheKeepalive.pinging(threadId);
  }

  async steer(threadId: string, text: string): Promise<boolean> {
    const handle = this.runner.handles.get(threadId);
    if (!handle?.steer || this.runner.steering.has(threadId)) return false;
    const turn = this.#core.journal.runningTurn(threadId);
    if (!turn || turn.execution?.operation === 'keepalive' || turn.execution?.operation === 'compact') return false;
    this.runner.steering.add(threadId);
    try {
      const submitted = await handle.steer(text);
      if (submitted && !this.#core.journal.isClosed()) this.noteCoordination(threadId, turn.id, text);
      return submitted;
    } finally {
      this.runner.steering.delete(threadId);
      void this.deferred.flushRunning(threadId);
    }
  }

  noteCoordination(threadId: string, turnId: string, text: string): void { this.noteSystem(threadId, turnId, text, 'Agent coordination', 'coordination.context'); }

  /** A line of Boite's own inside a running turn: what the agent was told, under a short label. */
  noteSystem(threadId: string, turnId: string, text: string, displayText: string, eventType: 'coordination.context' | 'turn.pausedForUpdate' | 'turn.resumedAfterUpdate' | 'turn.cutByUpdate'): void {
    const message: Message = { id: newId('msg_'), threadId, turnId, role: 'system', parts: [{ type: 'text', text, displayText }], state: 'complete', createdAt: Date.now() };
    this.#core.journal.append({ type: eventType, threadId, version: 1, payload: message }, () => this.#core.journal.putMessage(message));
    this.runner.noteMail(threadId, message.createdAt);
    this.#core.bus.emit('message.started', message);
    this.#core.bus.emit('message.completed', { threadId, messageId: message.id, state: 'complete' });
  }

  stopRunning(threadId: ThreadId): boolean {
    return this.runner.stopRunning(threadId);
  }

  markQueuedStopped(turnId: TurnId): void {
    markQueuedStopped(this.#core, turnId);
  }

  /** Closes the turns a stopped core left `running` or `queued` (`threads/recovery.ts`). */
  recoverStuckTurns(): number {
    return this.#recovery.recoverStuckTurns();
  }

  recoverTurn(params: RpcParams<'turns.recover'>): Turn {
    return this.#recovery.recover(params);
  }

  runTurn(turnId: TurnId, threadId: ThreadId): Promise<void> {
    return this.runner.runTurn(turnId, threadId);
  }

  // -- cards (`threads/cards.ts`) ---------------------------------------------

  listPermissions(threadId?: ThreadId): PermissionRequest[] {
    return this.cards.listPermissions(threadId);
  }

  /** `by` names who decided in the log: the user, or an agent acting for them. */
  answerPermission(params: { requestId: RequestId; decision: 'allow' | 'deny' }, by = 'user'): void {
    this.cards.answerPermission(params, by);
  }

  listQuestions(threadId?: ThreadId): QuestionRequest[] {
    return this.cards.listQuestions(threadId);
  }

  answerQuestion(params: { threadId: ThreadId; questionId: RequestId; optionIds: string[]; text?: string; attachments?: Attachment[] }, by = 'user'): void {
    this.cards.answerQuestion(params, by);
  }

  skipQuestion(params: { threadId: ThreadId; questionId: RequestId }, by = 'user'): void {
    this.cards.skipQuestion(params, by);
  }

  askAsync(params: { threadId: ThreadId; text: string; options?: string[]; multiple?: boolean }): { questionId: RequestId } {
    return this.cards.askAsync(params);
  }

  // -- internals ------------------------------------------------------------

  #save(thread: ThreadSummary, eventType: string): ThreadSummary {
    return saveThread(this.#core, thread, eventType);
  }

  #withLoad(thread: ThreadSummary): ThreadSummary {
    return withLoad(this.#core, thread);
  }
}
