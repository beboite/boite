import { MESSAGE_PAGE, MESSAGE_PAGE_MAX } from '@boite/contracts';
import type {
  Account,
  AccountId,
  Message,
  MessageId,
  MessagePart,
  MessageRole,
  ModelInfo,
  PermissionRequest,
  Protocol,
  ProviderDescriptor,
  QuestionAnswer,
  QuestionRequest,
  RequestId,
  Thread,
  ThreadId,
  ThreadStatus,
  ThreadSummary,
  Turn,
  TurnId,
} from '@boite/contracts';
import type { Core } from './core.ts';
import { messageOf, notFound, refused } from './errors.ts';
import { newId } from './ids.ts';
import { assertDriverRunnable, getDriver, probedModelsOf, releaseThread } from './drivers/index.ts';
import type {
  EmitSink,
  PermissionTicket,
  QuestionAsk,
  QuestionTicket,
  TurnContext,
  TurnHandle,
  TurnResult,
} from './drivers/types.ts';
import type { SpawnOptions } from './procs.ts';

/** What a turn a dead core left behind says, once the next core has closed it. */
export const CRASH_WHILE_RUNNING = 'The core stopped while this turn was running; send the prompt again.';
export const CRASH_WHILE_QUEUED = 'The core stopped while this turn was queued; send the prompt again.';

interface PendingPermission {
  request: PermissionRequest;
  resolve: (decision: 'allow' | 'deny') => void;
}

interface PendingQuestion {
  request: QuestionRequest;
  /** Null is the cancel: the turn ended before the user answered. */
  resolve: (answer: QuestionAnswer | null) => void;
}

export class ThreadStore {
  private readonly handles = new Map<ThreadId, TurnHandle>();
  private readonly permissions = new Map<RequestId, PendingPermission>();
  private readonly questions = new Map<RequestId, PendingQuestion>();

  constructor(private readonly core: Core) {}

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
  get(threadId: ThreadId): Thread {
    const thread = this.withLoad(this.require(threadId));
    const page = this.core.journal.listMessagePage(threadId, { limit: MESSAGE_PAGE });
    return {
      ...thread,
      messages: page.messages,
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
    return this.core.journal.listMessagePage(params.threadId, { beforeRowid: rowid, limit });
  }

  // -- writes ---------------------------------------------------------------

  create(params: {
    projectId: string;
    providerId: string;
    accountId: string;
    title?: string;
    cwd?: string;
    model?: string;
    effort?: string | null;
    permissionMode?: ThreadSummary['permissionMode'];
  }): ThreadSummary {
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

    const now = Date.now();
    const model = checkModel(provider, account.id, params.model ?? defaultModel(provider));
    const thread: ThreadSummary = {
      id: newId('thr_'),
      projectId: project.id,
      title: params.title !== undefined && params.title.length > 0 ? params.title : 'New thread',
      providerId: provider.id,
      accountId: account.id,
      model,
      effort: checkEffort(provider, account.id, model, params.effort ?? null),
      cwd: params.cwd !== undefined && params.cwd.length > 0 ? params.cwd : project.path,
      permissionMode: params.permissionMode ?? 'default',
      status: 'idle',
      unread: false,
      archived: false,
      pinned: false,
      sessionId: null,
      load: null,
      createdAt: now,
      updatedAt: now,
    };
    this.core.journal.append({ type: 'thread.created', threadId: thread.id, version: 1, payload: thread }, () => {
      this.core.journal.putThread(thread);
    });
    this.core.bus.emit('thread.created', thread);
    return thread;
  }

  update(params: {
    threadId: ThreadId;
    title?: string;
    model?: string;
    effort?: string | null;
    permissionMode?: ThreadSummary['permissionMode'];
  }): ThreadSummary {
    const thread = this.require(params.threadId);
    const next: ThreadSummary = { ...thread };
    if (params.title !== undefined && params.title.length > 0) next.title = params.title;
    const provider = this.core.providers.require(thread.providerId);
    if (params.model !== undefined && params.model !== thread.model) {
      // A new model starts on its own default unless the call says otherwise.
      next.model = checkModel(provider, thread.accountId, params.model);
      next.effort = null;
    }
    if (params.permissionMode !== undefined) next.permissionMode = params.permissionMode;
    if (params.effort !== undefined) next.effort = params.effort;
    // The model may have changed in the same call, so the scale is the new one's.
    next.effort = checkEffort(provider, thread.accountId, next.model, next.effort);
    return this.save(next, 'thread.updated');
  }

  archive(threadId: ThreadId, archived: boolean): ThreadSummary {
    this.require(threadId);
    // An archived thread is not coming back this minute: its warm process goes now.
    if (archived) {
      this.core.scheduler.stop(threadId);
      releaseThread(threadId);
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

  startTurn(threadId: ThreadId, prompt: string): Turn {
    const thread = this.require(threadId);
    if (thread.archived) throw refused('cannot start a turn on an archived thread', { threadId });
    if (['queued', 'running', 'waiting'].includes(thread.status) || this.handles.has(threadId)) {
      throw refused('this thread already has an in-flight turn', { threadId });
    }
    const provider = this.core.providers.require(thread.providerId);
    assertDriverRunnable(
      provider.protocol,
      this.core.providers.summary(thread.providerId),
      this.core.accounts.require(thread.accountId),
    );

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
    };
    const message: Message = {
      id: newId('msg_'),
      threadId,
      turnId: turn.id,
      role: 'user',
      parts: [{ type: 'text', text: prompt }],
      state: 'complete',
      createdAt: now,
    };

    this.core.journal.append({ type: 'turn.queued', threadId, version: 1, payload: turn }, () => {
      this.core.journal.putTurn(turn);
      this.core.journal.putMessage(message);
    });
    this.core.bus.emit('message.started', message);
    this.core.bus.emit('message.completed', { threadId, messageId: message.id, state: 'complete' });
    this.setStatus(threadId, 'queued');
    this.core.scheduler.enqueue(turn, thread.accountId);
    return turn;
  }

  stopTurn(threadId: ThreadId): boolean {
    this.require(threadId);
    return this.core.scheduler.stop(threadId);
  }

  stopRunning(threadId: ThreadId): boolean {
    const handle = this.handles.get(threadId);
    if (handle === undefined) return false;
    handle.stop();
    return true;
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
  }

  // -- crash recovery -------------------------------------------------------

  /**
   * A core that dies mid-turn leaves that turn `running` or `queued` in the
   * journal, and the next start comes up with an empty scheduler: nothing would
   * ever finish it, so the thread would read as busy forever. Every such turn
   * becomes an error here, through the same events a failing turn writes, before
   * the server accepts a connection. Nothing is retried: the prompt is in the
   * journal and the user sends it again.
   */
  recoverStuckTurns(): number {
    const stuck = this.core.journal.unfinishedTurns();
    for (const turn of stuck) {
      const previous = turn.status;
      this.core.journal.db.transaction(() => {
        this.failStuckTurn(turn, previous === 'running' ? CRASH_WHILE_RUNNING : CRASH_WHILE_QUEUED);
      })();
      this.core.log(
        'warn',
        `recovered turn ${turn.id} of thread ${turn.threadId}, left ${previous} by a stopped core`,
      );
    }
    for (const thread of this.core.journal.listThreads()) {
      if (['queued', 'running', 'waiting'].includes(thread.status)) {
        this.save({ ...thread, status: 'idle' }, 'thread.finished');
      }
    }
    return stuck.length;
  }

  private failStuckTurn(turn: Turn, reason: string): void {
    const threadId = turn.threadId;
    const thread = this.core.journal.getThread(threadId);
    if (thread !== null) {
      // The turn's own messages, and only the ones still open: a caret left
      // blinking on a message nobody will ever write to again is the visible half
      // of this bug.
      const streaming = this.core.journal
        .listMessages(threadId)
        .filter((message) => message.turnId === turn.id && message.state === 'streaming');
      const carrier = streaming.at(-1) ?? this.openRecoveryMessage(turn);
      const index = carrier.parts.length;
      const part: MessagePart = { type: 'error', message: reason };
      this.core.journal.append(
        { type: 'message.part', threadId, version: 1, payload: { messageId: carrier.id, partIndex: index, part } },
        () => {
          this.core.journal.setMessagePart(carrier.id, index, part);
        },
      );
      this.core.bus.emit('message.part', { threadId, messageId: carrier.id, partIndex: index, part });
      for (const message of streaming) if (message.id !== carrier.id) this.closeAsError(threadId, message.id);
      this.closeAsError(threadId, carrier.id);
    }

    const finished: Turn = { ...turn, status: 'error', finishedAt: Date.now(), error: reason };
    this.core.journal.append({ type: 'turn.finished', threadId, version: 1, payload: finished }, () => {
      this.core.journal.putTurn(finished);
    });
    this.core.bus.emit('turn.finished', finished);

    if (thread === null) return;
    this.save({ ...thread, status: 'idle' }, 'thread.finished');
  }

  /** A queued turn never opened a message; the error needs one to live in. */
  private openRecoveryMessage(turn: Turn): Message {
    const message: Message = {
      id: newId('msg_'),
      threadId: turn.threadId,
      turnId: turn.id,
      role: 'assistant',
      parts: [],
      state: 'streaming',
      createdAt: Date.now(),
    };
    this.core.journal.append(
      { type: 'message.started', threadId: turn.threadId, version: 1, payload: message },
      () => {
        this.core.journal.putMessage(message);
      },
    );
    this.core.bus.emit('message.started', message);
    return message;
  }

  private closeAsError(threadId: ThreadId, messageId: MessageId): void {
    this.core.journal.append(
      { type: 'message.completed', threadId, version: 1, payload: { messageId, state: 'error' } },
      () => {
        this.core.journal.setMessageState(messageId, 'error');
      },
    );
    this.core.bus.emit('message.completed', { threadId, messageId, state: 'error' });
  }

  // -- the turn itself ------------------------------------------------------

  async runTurn(turnId: TurnId, threadId: ThreadId): Promise<void> {
    const queued = this.core.journal.getTurn(turnId);
    const thread = this.core.journal.getThread(threadId);
    if (queued === null || thread === null) return;

    const running: Turn = { ...queued, status: 'running', startedAt: Date.now() };
    this.core.journal.append({ type: 'turn.started', threadId, version: 1, payload: running }, () => {
      this.core.journal.putTurn(running);
    });
    this.core.bus.emit('turn.started', running);
    this.setStatus(threadId, 'running');

    let result: TurnResult;
    try {
      const provider = this.core.providers.require(thread.providerId);
      const account = this.core.accounts.require(thread.accountId);
      const driver = getDriver(provider.protocol);
      const handle = driver.startTurn(this.makeContext(thread, provider, account, running));
      this.handles.set(threadId, handle);
      result = await handle.done;
    } catch (error) {
      result = { status: 'error', sessionId: thread.sessionId, usage: null, error: messageOf(error) };
    } finally {
      this.handles.delete(threadId);
    }

    if (this.core.journal.isClosed()) return;
    this.core.journal.flushDeltas();
    this.core.bus.flush();
    this.clearPermissionsOf(threadId);
    this.clearQuestionsOf(threadId);

    const finished: Turn = {
      ...running,
      status: result.status === 'done' ? 'done' : result.status,
      finishedAt: Date.now(),
      usage: result.usage,
      error: result.error ?? null,
    };
    this.core.journal.append({ type: 'turn.finished', threadId, version: 1, payload: finished }, () => {
      this.core.journal.putTurn(finished);
    });
    this.core.bus.emit('turn.finished', finished);

    if (result.status === 'error') {
      this.core.log('error', `turn ${turnId} failed: ${result.error ?? 'unknown error'}`);
    }

    const current = this.core.journal.getThread(threadId);
    if (current === null) return;
    if (current.archived) releaseThread(threadId);
    const next: ThreadSummary = {
      ...current,
      sessionId: result.sessionId ?? current.sessionId,
      status: result.status === 'error' ? 'error' : 'idle',
      unread: current.unread || !this.core.subscribers.hasSubscribers(threadId),
    };
    this.save(next, 'thread.finished');
  }

  /**
   * The requests still waiting for an answer, oldest first. Answering one or
   * finishing its turn takes it out, so what this returns is what a client has
   * to show, whether it was subscribed when the request fired or not.
   */
  listPermissions(threadId?: ThreadId): PermissionRequest[] {
    const pending = [...this.permissions.values()].map((entry) => entry.request);
    const scoped = threadId === undefined ? pending : pending.filter((r) => r.threadId === threadId);
    return scoped.sort((a, b) => a.createdAt - b.createdAt);
  }

  answerPermission(params: { requestId: RequestId; decision: 'allow' | 'deny' }): void {
    const pending = this.permissions.get(params.requestId);
    if (pending === undefined) throw notFound(`unknown permission request ${params.requestId}`, params);
    this.permissions.delete(params.requestId);
    const threadId = pending.request.threadId;
    this.core.journal.append(
      { type: 'permission.resolved', threadId, version: 1, payload: { ...params } },
      () => undefined,
    );
    this.core.bus.emit('permission.resolved', { requestId: params.requestId, threadId, decision: params.decision });
    this.setStatus(threadId, 'running');
    pending.resolve(params.decision);
  }

  /**
   * The questions still waiting for an answer, oldest first. The same rule as
   * the permissions: answering one or finishing its turn takes it out, so a
   * client that was not subscribed when it fired still draws the card.
   */
  listQuestions(threadId?: ThreadId): QuestionRequest[] {
    const pending = [...this.questions.values()].map((entry) => entry.request);
    const scoped = threadId === undefined ? pending : pending.filter((q) => q.threadId === threadId);
    return scoped.sort((a, b) => a.createdAt - b.createdAt);
  }

  answerQuestion(params: {
    threadId: ThreadId;
    questionId: RequestId;
    optionIds: string[];
    text?: string;
  }): void {
    const pending = this.questions.get(params.questionId);
    if (pending === undefined) throw notFound(`unknown question ${params.questionId}`, params);
    const request = pending.request;
    if (request.threadId !== params.threadId) {
      throw refused('the question belongs to another thread', {
        questionId: params.questionId,
        threadId: params.threadId,
        expected: request.threadId,
      });
    }

    const known = new Set(request.options.map((option) => option.id));
    const unknown = params.optionIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw refused('the question does not offer these options', {
        questionId: request.id,
        unknown,
        expected: [...known],
      });
    }
    if (!request.multiple && params.optionIds.length > 1) {
      throw refused('the question takes one option', { questionId: request.id, optionIds: params.optionIds });
    }
    const text = params.text ?? '';
    if (text.length > 0 && !request.allowText) {
      throw refused('the question takes no free text', { questionId: request.id });
    }
    if (params.optionIds.length === 0 && text.length === 0) {
      throw refused('an answer needs an option or some text', { questionId: request.id });
    }

    const answer: QuestionAnswer = text.length > 0 ? { optionIds: params.optionIds, text } : { optionIds: params.optionIds };
    this.questions.delete(request.id);
    this.core.journal.append(
      {
        type: 'question.answered',
        threadId: request.threadId,
        version: 1,
        payload: { questionId: request.id, answer },
      },
      () => undefined,
    );
    this.core.bus.emit('question.answered', { questionId: request.id, threadId: request.threadId, answer });
    this.setStatus(request.threadId, 'running');
    pending.resolve(answer);
  }

  // -- internals ------------------------------------------------------------

  private makeContext(
    thread: ThreadSummary,
    provider: ProviderDescriptor,
    account: Account,
    turn: Turn,
  ): TurnContext {
    const threadId = thread.id;
    const env = this.core.accounts.accountEnv(account, provider);
    const emit: EmitSink = {
      startMessage: (role: MessageRole): MessageId => {
        const message: Message = {
          id: newId('msg_'),
          threadId,
          turnId: turn.id,
          role,
          parts: [],
          state: 'streaming',
          createdAt: Date.now(),
        };
        this.core.journal.append({ type: 'message.started', threadId, version: 1, payload: message }, () => {
          this.core.journal.putMessage(message);
        });
        this.core.bus.emit('message.started', message);
        return message.id;
      },
      delta: (messageId: MessageId, partIndex: number, text: string): void => {
        this.core.journal.appendDelta(threadId, messageId, partIndex, text);
        this.core.bus.emit('message.delta', { threadId, messageId, partIndex, text });
      },
      part: (messageId: MessageId, partIndex: number, part: MessagePart): void => {
        this.core.journal.append(
          { type: 'message.part', threadId, version: 1, payload: { messageId, partIndex, part } },
          () => {
            this.core.journal.setMessagePart(messageId, partIndex, part);
          },
        );
        this.core.bus.emit('message.part', { threadId, messageId, partIndex, part });
      },
      complete: (messageId: MessageId, state: Message['state']): void => {
        this.core.journal.append(
          { type: 'message.completed', threadId, version: 1, payload: { messageId, state } },
          () => {
            this.core.journal.setMessageState(messageId, state);
          },
        );
        this.core.bus.emit('message.completed', { threadId, messageId, state });
      },
    };

    return {
      thread,
      account,
      provider,
      turn,
      prompt: this.lastUserPrompt(threadId, turn.id),
      sessionId: thread.sessionId,
      accountEnv: env,
      warmProcessMinutes: this.core.settings.get().warmProcessMinutes,
      emit,
      log: (level, message) => {
        this.core.log(level, message);
      },
      requestPermission: (toolName: string, input: unknown, description: string | null): PermissionTicket =>
        this.requestPermission(thread, turn, toolName, input, description),
      askQuestion: (ask: QuestionAsk): QuestionTicket => this.askQuestion(thread, turn, ask),
      // Every driver reaches the launcher through these two, so this is the one
      // place a lease on the provider's managed files can be held for the life
      // of an agent process, warm sessions included. `providers.uninstall`
      // refuses while the count is above zero.
      spawn: (cmd: string, args: string[], opts?: SpawnOptions) => {
        const spawned = this.core.procs.spawn(threadId, cmd, args, {
          ...opts,
          env: { ...(opts?.env ?? {}), ...env },
        });
        const installs = this.core.providers.installs;
        installs.acquire(provider.id);
        void spawned.exited.finally(() => {
          installs.release(provider.id);
        });
        return spawned;
      },
      spawnChild: (cmd: string, args: string[], opts?: SpawnOptions) => {
        const child = this.core.procs.spawnChild(threadId, cmd, args, opts);
        const installs = this.core.providers.installs;
        installs.acquire(provider.id);
        let released = false;
        const drop = (): void => {
          if (released) return;
          released = true;
          installs.release(provider.id);
        };
        child.once('exit', drop);
        child.once('error', drop);
        return child;
      },
    };
  }

  private requestPermission(
    thread: ThreadSummary,
    turn: Turn,
    toolName: string,
    input: unknown,
    description: string | null,
  ): PermissionTicket {
    const request: PermissionRequest = {
      id: newId('req_'),
      threadId: thread.id,
      turnId: turn.id,
      toolName,
      input,
      description,
      createdAt: Date.now(),
    };
    let resolve: (decision: 'allow' | 'deny') => void = () => undefined;
    const promise = new Promise<'allow' | 'deny'>((done) => {
      resolve = done;
    });
    this.permissions.set(request.id, { request, resolve });
    this.core.journal.append(
      { type: 'permission.requested', threadId: thread.id, version: 1, payload: request },
      () => undefined,
    );
    this.setStatus(thread.id, 'waiting');
    this.core.bus.emit('permission.requested', request);
    return Object.assign(promise, { requestId: request.id });
  }

  private askQuestion(thread: ThreadSummary, turn: Turn, ask: QuestionAsk): QuestionTicket {
    const request: QuestionRequest = {
      id: newId('qst_'),
      threadId: thread.id,
      turnId: turn.id,
      text: ask.text,
      options: ask.options,
      allowText: ask.allowText,
      multiple: ask.multiple,
      createdAt: Date.now(),
    };
    let resolve: (answer: QuestionAnswer | null) => void = () => undefined;
    const promise = new Promise<QuestionAnswer | null>((done) => {
      resolve = done;
    });
    this.questions.set(request.id, { request, resolve });
    this.core.journal.append(
      { type: 'question.asked', threadId: thread.id, version: 1, payload: request },
      () => undefined,
    );
    this.setStatus(thread.id, 'waiting');
    this.core.bus.emit('question.asked', request);
    return Object.assign(promise, { questionId: request.id });
  }

  /** The turn ended with a question still open: it is cancelled, so the driver settles. */
  private clearQuestionsOf(threadId: ThreadId): void {
    for (const [id, pending] of [...this.questions]) {
      if (pending.request.threadId !== threadId) continue;
      this.questions.delete(id);
      this.core.bus.emit('question.answered', { questionId: id, threadId, answer: null });
      pending.resolve(null);
    }
  }

  private clearPermissionsOf(threadId: ThreadId): void {
    for (const [id, pending] of [...this.permissions]) {
      if (pending.request.threadId !== threadId) continue;
      this.permissions.delete(id);
      pending.resolve('deny');
    }
  }

  private lastUserPrompt(threadId: ThreadId, turnId: TurnId): string {
    const messages = this.core.journal.listMessages(threadId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message === undefined || message.turnId !== turnId || message.role !== 'user') continue;
      return message.parts
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('');
    }
    return '';
  }

  private setStatus(threadId: ThreadId, status: ThreadStatus): void {
    const thread = this.core.journal.getThread(threadId);
    if (thread === null || thread.status === status) return;
    this.save({ ...thread, status }, 'thread.status');
  }

  private save(thread: ThreadSummary, eventType: string): ThreadSummary {
    const next: ThreadSummary = { ...thread, updatedAt: Date.now() };
    this.core.journal.append({ type: eventType, threadId: next.id, version: 1, payload: next }, () => {
      this.core.journal.putThread(next);
    });
    const summary = this.withLoad(next);
    this.core.bus.emit('thread.updated', summary);
    return summary;
  }

  private withLoad(thread: ThreadSummary): ThreadSummary {
    return { ...thread, load: this.core.procs.loadOf(thread.id) };
  }
}

/** The protocols whose models come from the agent, not from the descriptor. */
const PROBED_PROTOCOLS: readonly Protocol[] = ['acp', 'codex-appserver', 'pi'];

/**
 * What this account may run: the descriptor's models, plus the ones the last
 * probe read from the agent for a provider that owns its own list. Nothing is
 * probed here; a model the agent could list but nobody asked for is not offered
 * yet.
 */
function modelsFor(provider: ProviderDescriptor, accountId: AccountId): ModelInfo[] {
  const probed = probedModelsOf(provider.protocol, provider.id, accountId);
  if (probed === null) return provider.models;
  const known = new Set(probed.map((model) => model.id));
  return [...probed, ...provider.models.filter((model) => !known.has(model.id))];
}

/**
 * Null is always allowed and means the provider's own default. Anything else
 * must be a model the descriptor lists or one the last probe read.
 */
function checkModel(provider: ProviderDescriptor, accountId: AccountId, model: string | null): string | null {
  if (model === null) return null;
  const models = modelsFor(provider, accountId);
  if (models.some((entry) => entry.id === model)) return model;
  throw refused(
    PROBED_PROTOCOLS.includes(provider.protocol)
      ? 'the agent has not listed this model: open the model picker so Boite reads its models first'
      : 'the provider does not offer this model',
    { providerId: provider.id, accountId, model, expected: models.map((entry) => entry.id) },
  );
}

/**
 * Null is always allowed and means the model's own default. Anything else must
 * be one of the levels that model lists, from the descriptor or from the probe,
 * or the call is refused.
 */
function checkEffort(
  provider: ProviderDescriptor,
  accountId: AccountId,
  model: string | null,
  effort: string | null,
): string | null {
  if (effort === null) return null;
  const levels = modelsFor(provider, accountId).find((entry) => entry.id === model)?.effort?.levels ?? [];
  if (levels.some((level) => level.id === effort)) return effort;
  throw refused('the model does not offer this reasoning effort', {
    providerId: provider.id,
    model,
    effort,
    expected: levels.length === 0 ? 'null: this model has no effort levels' : levels.map((level) => level.id),
  });
}

function defaultModel(provider: ProviderDescriptor): string | null {
  const preferred = provider.models.find((model) => model.default === true);
  if (preferred !== undefined) return preferred.id;
  return provider.models[0]?.id ?? null;
}

export function registerThreadMethods(core: Core): void {
  core.router.register('threads.list', (params) => core.threads.list(params));
  core.router.register('threads.create', (params) => core.threads.create(params));
  core.router.register('threads.get', (params) => core.threads.get(params.threadId));
  core.router.register('messages.list', (params) => core.threads.messages(params));
  core.router.register('threads.update', (params) => core.threads.update(params));
  core.router.register('threads.archive', (params) =>
    core.threads.archive(params.threadId, params.archived !== false),
  );
  core.router.register('threads.pin', (params) => core.threads.pin(params.threadId, params.pinned !== false));
  core.router.register('threads.markRead', (params) => {
    core.threads.markRead(params.threadId);
    return { ok: true } as const;
  });
  core.router.register('threads.subscribe', (params, ctx) => {
    core.threads.require(params.threadId);
    ctx.connection.subscriptions.add(params.threadId);
    return { ok: true } as const;
  });
  core.router.register('threads.unsubscribe', (params, ctx) => {
    ctx.connection.subscriptions.delete(params.threadId);
    return { ok: true } as const;
  });
  core.router.register('turns.start', (params) => core.threads.startTurn(params.threadId, params.prompt));
  core.router.register('turns.stop', (params) => ({ stopped: core.threads.stopTurn(params.threadId) }));
  core.router.register('permissions.list', (params) => core.threads.listPermissions(params.threadId));
  core.router.register('permissions.answer', (params) => {
    core.threads.answerPermission({ requestId: params.requestId, decision: params.decision });
    return { ok: true } as const;
  });
  core.router.register('questions.list', (params) => core.threads.listQuestions(params.threadId));
  core.router.register('questions.answer', (params) => {
    core.threads.answerQuestion({
      threadId: params.threadId,
      questionId: params.questionId,
      optionIds: params.optionIds,
      ...(params.text === undefined ? {} : { text: params.text }),
    });
    return { ok: true } as const;
  });
}
