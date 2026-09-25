import type { AgentProfile } from '@boite/contracts';
import { createHash } from 'node:crypto';
import { previewReferencesError, previewPrompt, MESSAGE_PAGE, MESSAGE_PAGE_MAX } from '@boite/contracts';
import type {
  Account,
  AccountId,
  Attachment,
  PreviewReference,
  ImageMimeType,
  Message,
  MessageId,
  MessagePart,
  PermissionRequest,
  Project,
  ProviderDescriptor,
  QuestionRequest,
  RequestId,
  RpcParams,
  Thread,
  ThreadId,
  ThreadStatus,
  ThreadSummary,
  Turn,
  TurnId,
} from '@boite/contracts';
import type { Core } from './core.ts';
import { threadTerminalId } from './terminals.ts';
import { notFound, refused } from './errors.ts';
import { newId } from './ids.ts';
import { assertDriverRunnable, releaseThread } from './drivers/index.ts';
import { AgentState } from './threads/agent-state.ts';
import { ThreadCards } from './threads/cards.ts';
import { DeferredInput } from './threads/deferred.ts';
import { checkAttachmentArray, checkAttachments, checkCwd, draftFolderName, makeDraftFolder, titleOf } from './threads/inputs.ts';
import { SYSTEM_LABEL, systemOperation } from './threads/operations.ts';
import { saveThread, setThreadStatus, withLoad } from './threads/records.ts';
import { ThreadRecovery } from './threads/recovery.ts';
import { ThreadTitles } from './threads/retitle.ts';
import { checkEffort, checkModel, checkSpeed, checkStoredEffort, defaultModel } from './threads/selection.ts';
import { TurnContexts } from './threads/turn-context.ts';
import { TurnRunner } from './threads/turn-runner.ts';

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
  /** Permission and question cards. */
  readonly cards: ThreadCards;
  /** Held asynchronous answers and wakes. */
  readonly deferred: DeferredInput;
  /** Commands, background tasks and context the agent reported. */
  readonly agentState: AgentState;
  readonly titles: ThreadTitles;
  private readonly recovery: ThreadRecovery;

  constructor(private readonly core: Core) {
    this.runner = new TurnRunner(core, this);
    this.contexts = new TurnContexts(core, this);
    this.cards = new ThreadCards(core, this);
    this.deferred = new DeferredInput(core, this);
    this.agentState = new AgentState(core);
    this.titles = new ThreadTitles(core, this);
    this.recovery = new ThreadRecovery(core);
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
    const placed = await this.core.worktrees.add(id, project, titleOf(params.title), params.worktree?.branch);
    try {
      return this.create({ ...params, cwd: placed.path }, { id, branch: placed.branch });
    } catch (error) {
      await this.core.worktrees.remove(id, project, placed);
      throw error;
    }
  }

  create(params: CreateParams, placed?: { id: ThreadId; branch: string | null; parentThreadId?: ThreadId }): ThreadSummary {
    const { project, provider, account } = this.check(params);

    const now = Date.now();
    const model = checkModel(provider, account.id, params.model ?? defaultModel(provider));
    const effort = checkEffort(provider, account.id, model, params.effort ?? null);
    const speed = checkSpeed(provider, account.id, model, params.speed ?? null);
    // A worktree's directory is the core's own and sits beside the project;
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

  archive(threadId: ThreadId, archived: boolean): ThreadSummary {
    this.require(threadId);
    // An archived thread is not coming back this minute: its warm process goes
    // now, and the commands that process listed go with it.
    if (archived) {
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
    return this.save({ ...thread, archived }, 'thread.archived');
  }

  markRead(threadId: ThreadId): void {
    const thread = this.require(threadId);
    if (!thread.unread) return;
    this.save({ ...thread, unread: false }, 'thread.read');
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

  compact(threadId: ThreadId, expectedSelectionVersion?: number): Turn {
    const thread = this.require(threadId);
    const protocol = this.core.providers.require(thread.providerId).protocol;
    if (!thread.sessionId) throw refused('this thread has no native session to compact', { threadId });
    if (protocol === 'acp' && !this.agentState.commands.get(threadId)?.some((command) => command.name === 'compact')) {
      throw refused('this agent has not advertised a compact command', { threadId });
    }
    // agy's print mode refuses every interactive-only slash command, `/compact` among them.
    if (protocol === 'agy') throw refused('the Antigravity CLI takes no /compact in print mode', { threadId });
    return this.startTurn(threadId, protocol === 'echo' ? '[compact]' : '/compact', [], expectedSelectionVersion, 'compact');
  }

  startTurn(threadId: ThreadId, prompt: string, attachments: Attachment[] = [], expectedSelectionVersion?: number, operation?: NonNullable<Turn['execution']>['operation'], activity?: { kind: 'goal' | 'loop'; iteration: number }, clientRequestId?: string, displayText?: string, previewReferences: PreviewReference[] = [], agentRunId?: string): Turn {
    if (this.core.stopping) throw refused('the core is stopping; reconnect before sending another prompt');
    const thread = this.require(threadId);
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
      throw refused('this thread already has an in-flight turn', { threadId });
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

    const now = Date.now();
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
        sessionGeneration: thread.sessionGeneration ?? 0, selectionVersion: thread.selectionVersion ?? 0,
        ...(operation ? { operation } : {}),
      },
    };
    const message: Message = {
      id: newId('msg_'),
      threadId,
      turnId: turn.id,
      role: systemOperation(operation) ? 'system' : 'user',
      parts: [
        { type: 'text', text: previewPrompt(prompt, previewReferences), ...(previewReferences.length ? { displayText: prompt, previewReferences } : {}), ...(systemOperation(operation) ? { displayText: displayText ?? SYSTEM_LABEL[operation] } : {}), ...(activity ? { activity } : {}) },
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

    this.core.journal.append({ type: 'turn.queued', threadId, version: 1, payload: turn }, () => {
      this.core.delegation.reserveTurn(threadId, operation);
      this.core.journal.putTurn(turn);
      this.core.journal.putMessage(message);
      if (clientRequestId) this.core.journal.putTurnRequest(threadId, clientRequestId, fingerprint, turn.id);
    });
    // A turn of the user's own, once accepted, takes whatever the agent wrote by itself first.
    if (operation !== 'background') this.deferred.pendingWakes.delete(threadId);
    if (!activity && !operation) this.core.activity.userPrompt(threadId);
    this.core.bus.emit('message.started', message);
    this.core.bus.emit('message.completed', { threadId, messageId: message.id, state: 'complete' });
    this.setStatus(threadId, 'queued');
    this.core.scheduler.enqueue(turn, thread.accountId);
    return turn;
  }

  stopTurn(threadId: ThreadId): boolean {
    this.require(threadId);
    this.core.coordination.pause(threadId);
    const childrenStopped = this.core.delegation.stop(threadId);
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
    } finally { this.runner.steering.delete(threadId); }
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
    this.core.journal.append({ type: 'turn.stopped', threadId: turn.threadId, version: 1, payload: next }, () => {
      this.core.journal.putTurn(next);
    });
    this.core.bus.emit('turn.finished', next);
    this.setStatus(turn.threadId, 'idle');
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
