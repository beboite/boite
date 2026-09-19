import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { activityPrompt } from './activity-prompt.ts';
import { relative, resolve } from 'node:path';
import { attachmentError, MESSAGE_PAGE, MESSAGE_PAGE_MAX } from '@boite/contracts';
import type {
  Account,
  AccountId,
  AgentCommand,
  Attachment,
  ImageMimeType,
  Message,
  MessageId,
  MessagePart,
  MessageRole,
  ModelInfo,
  PermissionRequest,
  Project,
  Protocol,
  ProviderDescriptor,
  QuestionAnswer,
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
import { agentEnvOf } from './agent.ts';
import type { Core } from './core.ts';
import { messageOf, notFound, refused } from './errors.ts';
import { newId } from './ids.ts';
import { PullRequests } from './pull-requests.ts';
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
import type { SpawnedChild, SpawnOptions } from './procs.ts';
import { cleanAgentTitle, textOf, titleFromPrompt } from './titles.ts';
import { prepareAttachments, fileReference } from './attachments.ts';
import { continuationInput } from './continuation.ts';

type CreateParams = RpcParams<'threads.create'>;

function titleOf(title: string | undefined): string {
  return title !== undefined && title.length > 0 ? title : 'New thread';
}

/**
 * The working directory a client asked for, resolved and kept inside the
 * project. The agent runs there, so an unchecked string is a way to point any
 * process at any directory on the machine: the worktree path the core builds
 * itself is the one exception, and it never comes through `params.cwd`.
 */
function checkCwd(project: Project, cwd: string): string {
  const resolved = resolve(cwd);
  const inside = relative(resolve(project.path), resolved);
  if (inside.startsWith('..') || resolve(inside) === inside) {
    throw refused('the working directory must be inside the project', {
      cwd: resolved,
      projectPath: project.path,
    });
  }
  let stat;
  try {
    stat = statSync(resolved);
  } catch (error) {
    throw refused(`the working directory cannot be read: ${messageOf(error)}`, { cwd: resolved });
  }
  if (!stat.isDirectory()) throw refused('the working directory is not a directory', { cwd: resolved });
  return resolved;
}

/**
 * The attachments of a turn, or the refusal: the provider takes none, too
 * many, a format no agent reads, a body that is not base64, one over the cap.
 * Each refusal names the attachment by its index and what was expected.
 */
function checkAttachmentArray(attachments: Attachment[]): void {
  if (!Array.isArray(attachments)) throw refused('attachments must be an array');
  attachments.forEach((attachment, index) => {
    if (!attachment || typeof attachment !== 'object') throw refused(`attachment ${index + 1}: expected an object`);
  });
}

export function checkAttachments(attachments: Attachment[], provider: ProviderDescriptor): void {
  const error = attachmentError(attachments, provider);
  if (error) throw refused(error.message, error.data);
}

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
  /**
   * What each thread's agent last said it takes as `/name`. Memory only: the
   * list belongs to the agent process, so a fresh core learns it again on the
   * next turn, and nothing here is worth a journal row.
   */
  private readonly commands = new Map<ThreadId, AgentCommand[]>();
  /** The threads a title is being written for right now: a second ask is refused, not doubled. */
  private readonly retitling = new Set<ThreadId>();

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
      commands: this.commands.get(threadId) ?? [],
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

  create(params: CreateParams, placed?: { id: ThreadId; branch: string }): ThreadSummary {
    const { project, provider, account } = this.check(params);

    const now = Date.now();
    const model = checkModel(provider, account.id, params.model ?? defaultModel(provider));
    const thread: ThreadSummary = {
      id: placed?.id ?? newId('thr_'),
      projectId: project.id,
      title: titleOf(params.title),
      titleSource: 'prompt',
      providerId: provider.id,
      accountId: account.id,
      model,
      effort: checkEffort(provider, account.id, model, params.effort ?? null),
      speed: checkSpeed(provider, account.id, model, params.speed ?? null),
      // A worktree's directory is the core's own and sits beside the project;
      // anything a client names has to be inside it.
      cwd:
        params.cwd !== undefined && params.cwd.length > 0
          ? placed !== undefined
            ? params.cwd
            : checkCwd(project, params.cwd)
          : project.path,
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
      assertDriverRunnable(provider.protocol, this.core.providers.summary(provider.id), account);
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
      if (!['queued', 'running', 'waiting'].includes(thread.status)) releaseThread(thread.id);
      this.commands.delete(thread.id);
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
      this.core.scheduler.stop(threadId);
      releaseThread(threadId);
      this.commands.delete(threadId);
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
  async retitle(threadId: ThreadId): Promise<ThreadSummary> {
    const thread = this.require(threadId);
    if (this.retitling.has(threadId)) {
      throw refused('a title is already being written for this thread', { threadId });
    }
    const messages = this.core.journal.listMessages(threadId);
    const first = messages.find((message) => message.role === 'user');
    if (first === undefined) throw refused('this thread has no prompt to write a title from', { threadId });
    const prompt = textOf(first);
    const answer = messages.find((message) => message.role === 'assistant' && textOf(message).length > 0);
    const provider = this.core.providers.require(thread.providerId);
    const account = this.core.accounts.require(thread.accountId);
    const driver = getDriver(provider.protocol);

    this.retitling.add(threadId);
    let agentTitle: string | null = null;
    try {
      if (driver.title !== undefined) {
        const raw = await driver.title({
          thread,
          provider,
          account,
          accountEnv: this.core.accounts.accountEnv(account, provider),
          prompt,
          answer: answer === undefined ? '' : textOf(answer),
          spawnChild: this.leasedSpawnChild(threadId, provider),
          log: (level, message) => {
            this.core.log(level, message);
          },
        });
        agentTitle = raw === null ? null : cleanAgentTitle(raw);
      }
    } catch (error) {
      this.core.log('warn', `no title from ${provider.name} for thread ${threadId}: ${messageOf(error)}`);
    } finally {
      this.retitling.delete(threadId);
    }
    if (this.core.journal.isClosed()) return thread;

    // The thread as it stands now: a rename that landed during the ask is the
    // user's, and the agent's words do not go over it. Asking again on a name
    // the user typed earlier is still allowed, since that ask is his own.
    const current = this.require(threadId);
    if (current.titleSource === 'user' && current.title !== thread.title) return this.withLoad(current);
    if (agentTitle !== null) return this.save({ ...current, title: agentTitle, titleSource: 'agent' }, 'thread.updated');
    const fromPrompt = titleFromPrompt(prompt);
    if (fromPrompt.length === 0 || (fromPrompt === current.title && current.titleSource === 'prompt')) {
      return this.withLoad(current);
    }
    return this.save({ ...current, title: fromPrompt, titleSource: 'prompt' }, 'thread.updated');
  }

  /**
   * The first finished turn of a thread still called by its prompt gets the
   * agent's title, when the driver writes one. Not awaited by the turn: the
   * title lands as its own `thread.updated`, seconds later on a real agent.
   */
  private autoTitle(threadId: ThreadId, turnId: TurnId): void {
    const thread = this.core.journal.getThread(threadId);
    if (thread === null || thread.archived || thread.titleSource !== 'prompt') return;
    const provider = this.core.providers.get(thread.providerId);
    if (provider === undefined || getDriver(provider.protocol).title === undefined) return;
    const done = this.core.journal.listTurns(threadId).filter((turn) => turn.status === 'done');
    if (done.length !== 1 || done[0]?.id !== turnId) return;
    void this.retitle(threadId).catch((error: unknown) => {
      this.core.log('warn', `no title for thread ${threadId}: ${messageOf(error)}`);
    });
  }

  compact(threadId: ThreadId, expectedSelectionVersion?: number): Turn {
    const thread = this.require(threadId);
    const protocol = this.core.providers.require(thread.providerId).protocol;
    if (!thread.sessionId) throw refused('this thread has no native session to compact', { threadId });
    if (protocol === 'acp' && !this.commands.get(threadId)?.some((command) => command.name === 'compact')) {
      throw refused('this agent has not advertised a compact command', { threadId });
    }
    return this.startTurn(threadId, protocol === 'echo' ? '[compact]' : '/compact', [], expectedSelectionVersion, 'compact');
  }

  startTurn(threadId: ThreadId, prompt: string, attachments: Attachment[] = [], expectedSelectionVersion?: number, operation?: 'compact', activity?: { kind: 'goal' | 'loop'; iteration: number }, clientRequestId?: string): Turn {
    const thread = this.require(threadId);
    checkAttachmentArray(attachments);
    let fingerprint = '';
    if (clientRequestId !== undefined) {
      if (typeof clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(clientRequestId)) throw refused('clientRequestId must contain 8 to 128 URL-safe characters');
      fingerprint = createHash('sha256').update(JSON.stringify([prompt, attachments.map(a => [a.kind, a.mimeType, a.data, a.name])])).digest('hex');
      const existing = this.core.journal.turnRequest(threadId, clientRequestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw refused('clientRequestId was already used for different content');
        const accepted = this.core.journal.getTurn(existing.turn_id);
        if (accepted) return accepted;
      }
    }
    this.checkSelection(thread, expectedSelectionVersion);
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
    checkEffort(provider, thread.accountId, thread.model, thread.effort);
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
      role: 'user',
      parts: [
        { type: 'text', text: prompt, ...(activity ? { activity } : {}) },
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
      this.core.journal.putTurn(turn);
      this.core.journal.putMessage(message);
      if (clientRequestId) this.core.journal.putTurnRequest(threadId, clientRequestId, fingerprint, turn.id);
    });
    if (!activity && !operation) this.core.activity.userPrompt(threadId);
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
    // An open card is what the driver is parked on. Aborting without answering
    // it leaves that await pending for good: the turn never finishes, the
    // thread stays `waiting`, and Stop does nothing the user can see.
    this.clearPermissionsOf(threadId);
    this.clearQuestionsOf(threadId);
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
    const selected = this.core.journal.getThread(threadId);
    if (queued === null || selected === null) return;
    const thread = { ...selected, ...queued.execution };

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
    const sameSession = (current.sessionGeneration ?? 0) === (thread.sessionGeneration ?? 0);
    if (current.archived || !sameSession) releaseThread(threadId);
    const next: ThreadSummary = {
      ...current,
      sessionId: sameSession ? result.sessionId ?? current.sessionId : current.sessionId,
      status: result.status === 'error' ? 'error' : 'idle',
      unread: current.unread || !this.core.subscribers.hasSubscribers(threadId),
    };
    this.save(next, 'thread.finished');
    if (result.status === 'done' && sameSession && queued.execution?.operation !== 'compact') this.autoTitle(threadId, turnId);
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

  /**
   * Is anything of this thread still waiting on the user? An agent can run two
   * tools at once and raise a card for each, so answering one does not mean the
   * turn is running again.
   */
  private waitingOn(threadId: ThreadId): boolean {
    for (const entry of this.permissions.values()) if (entry.request.threadId === threadId) return true;
    for (const entry of this.questions.values()) if (entry.request.threadId === threadId) return true;
    return false;
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
    this.setStatus(threadId, this.waitingOn(threadId) ? 'waiting' : 'running');
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
    this.setStatus(request.threadId, this.waitingOn(request.threadId) ? 'waiting' : 'running');
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

    const input = this.lastUserInput(threadId, turn.id);
    const continued = thread.sessionId === null && (thread.sessionGeneration ?? 0) > 0
      ? continuationInput(this.core.journal, threadId, turn.id, input, provider, part => fileReference(this.core.dataDir, part))
      : input;
    const prepared = prepareAttachments(this.core.dataDir, continued);
    return {
      thread,
      account,
      provider,
      turn,
      prompt: prepared.prompt,
      attachments: prepared.attachments,
      sessionId: thread.sessionId,
      accountEnv: env,
      warmProcessMinutes: this.core.settings.get().warmProcessMinutes,
      emit,
      log: (level, message) => {
        this.core.log(level, message);
      },
      commands: (list: AgentCommand[]) => {
        if ((this.require(threadId).sessionGeneration ?? 0) === (thread.sessionGeneration ?? 0)) this.noteCommands(threadId, list);
      },
      context: (use) => {
        if ((this.require(threadId).selectionVersion ?? 0) === (thread.selectionVersion ?? 0)) this.noteContext(threadId, use);
      },
      tasks: (list) => this.core.activity.tasks(threadId, list),
      requestPermission: (toolName: string, input: unknown, description: string | null): PermissionTicket =>
        this.requestPermission(thread, turn, toolName, input, description),
      askQuestion: (ask: QuestionAsk): QuestionTicket => this.askQuestion(thread, turn, ask),
      // Every driver reaches the launcher through these two, so this is the one
      // place a lease on the provider's managed files can be held for the life
      // of an agent process, warm sessions included. `providers.uninstall`
      // refuses while the count is above zero. It is also where the thread's
      // own door goes into the environment: everything a thread launches finds
      // the core, its token and the `boite` CLI, grandchildren included.
      spawn: (cmd: string, args: string[], opts?: SpawnOptions) => {
        const spawned = this.core.procs.spawn(threadId, cmd, args, {
          ...opts,
          env: agentEnvOf(this.core, threadId, { ...(opts?.env ?? process.env), ...env }),
        });
        const installs = this.core.providers.installs;
        installs.acquire(provider.id);
        void spawned.exited.finally(() => {
          installs.release(provider.id);
        });
        return spawned;
      },
      spawnChild: this.leasedSpawnChild(threadId, provider),
    };
  }

  /** `procs.spawnChild` under the thread, holding the provider's install lease for the child's life. */
  private leasedSpawnChild(
    threadId: ThreadId,
    provider: ProviderDescriptor,
  ): (cmd: string, args: string[], opts?: SpawnOptions) => SpawnedChild {
    return (cmd, args, opts) => {
      // The SDK drivers hand a whole environment here, so the agent's own
      // variables are merged onto theirs rather than added to `process.env`.
      const child = this.core.procs.spawnChild(threadId, cmd, args, {
        ...opts,
        env: agentEnvOf(this.core, threadId, opts?.env ?? process.env),
      });
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

  /** The turn ended with a card still open: it is denied, and every client is told so. */
  private clearPermissionsOf(threadId: ThreadId): void {
    for (const [id, pending] of [...this.permissions]) {
      if (pending.request.threadId !== threadId) continue;
      this.permissions.delete(id);
      // Without this the card stays on screen with live buttons, and pressing
      // one answers `unknown permission request`.
      this.core.bus.emit('permission.resolved', { requestId: id, threadId, decision: 'deny' });
      pending.resolve('deny');
    }
  }

  /** The user message of the turn, read back from the journal: the text and the images it carried. */
  private lastUserInput(threadId: ThreadId, turnId: TurnId): { prompt: string; attachments: Attachment[] } {
    const message = this.core.journal.lastUserMessage(threadId, turnId);
    if (message !== null) {
      const attachments: Attachment[] = [];
      for (const part of message.parts) {
        if (part.type === 'file') attachments.push({ kind: 'file', mimeType: part.mimeType, data: part.data, name: part.name });
        if (part.type === 'image') {
          attachments.push({ kind: 'image', mimeType: part.mimeType, data: part.data, name: part.alt });
        }
      }
      return {
        prompt: message.parts.map((part) => part.type === 'text' ? part.activity ? activityPrompt(part.activity.kind, part.text, part.activity.iteration) : part.text : '').join(''),
        attachments,
      };
    }
    return { prompt: '', attachments: [] };
  }

  /**
   * The agent's command list, whole, as a driver reports it. A name listed
   * twice keeps its first entry, an empty or non-string name is dropped, and
   * the same list twice is no event: the clients only hear a change.
   */
  private noteCommands(threadId: ThreadId, list: AgentCommand[]): void {
    const seen = new Set<string>();
    const commands: AgentCommand[] = [];
    for (const entry of list) {
      const name = typeof entry.name === 'string' ? entry.name.trim().replace(/^\//, '') : '';
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      commands.push({
        name,
        description: typeof entry.description === 'string' && entry.description.length > 0 ? entry.description : null,
        hint: typeof entry.hint === 'string' && entry.hint.length > 0 ? entry.hint : null,
      });
    }
    const before = this.commands.get(threadId);
    if (before !== undefined && JSON.stringify(before) === JSON.stringify(commands)) return;
    this.commands.set(threadId, commands);
    this.core.bus.emit('thread.commands', { threadId, commands });
  }

  /** The context meter, whole numbers only: a driver that misreads its agent writes nothing. */
  private noteContext(threadId: ThreadId, use: Omit<import('@boite/contracts').ContextUse, 'at'>): void {
    const tokens = Number.isFinite(use.tokens) && use.tokens >= 0 ? Math.round(use.tokens) : null;
    if (tokens === null) return;
    const window = use.window !== null && Number.isFinite(use.window) && use.window > 0 ? Math.round(use.window) : null;
    const thread = this.core.journal.getThread(threadId);
    if (thread === null) return;
    const breakdown = use.breakdown && Object.values(use.breakdown).every(n => Number.isFinite(n) && n >= 0)
      && Math.abs(use.breakdown.input + use.breakdown.cache + use.breakdown.output - tokens) <= 1 ? use.breakdown : undefined;
    this.save({ ...thread, context: { tokens, window, ...(breakdown ? {breakdown} : {}), at: Date.now() } }, 'thread.context');
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
const PROBED_PROTOCOLS: readonly Protocol[] = ['acp', 'codex-appserver', 'muse', 'pi'];

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
  const pullRequests = new PullRequests(core);
  core.router.register('threads.pullRequest', params => pullRequests.read(params.threadId));
  core.router.register('threads.compact', (params) => core.threads.compact(params.threadId, params.expectedSelectionVersion));
  core.router.register('threads.list', (params) => core.threads.list(params));
  core.router.register('threads.create', (params) =>
    params.worktree === undefined ? core.threads.create(params) : core.threads.createInWorktree(params),
  );
  core.router.register('threads.get', (params) => core.threads.get(params.threadId));
  core.router.register('messages.list', (params) => core.threads.messages(params));
  core.router.register('threads.update', (params) => core.threads.update(params));
  core.router.register('threads.retitle', (params) => core.threads.retitle(params.threadId));
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
  core.router.register('turns.start', (params) =>
    core.threads.startTurn(params.threadId, params.prompt, params.attachments ?? [], params.expectedSelectionVersion, undefined, undefined, params.clientRequestId),
  );
  core.router.register('turns.stop', (params) => {
    core.activity.pauseAll(params.threadId);
    return { stopped: core.threads.stopTurn(params.threadId) };
  });
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

function checkSpeed(provider: ProviderDescriptor, accountId: string, model: string | null, speed: string | null): string | null {
  if (speed === null) return null;
  const options = modelsFor(provider, accountId).find(entry => entry.id === model)?.speeds ?? [];
  if (options.some(option => option.id === speed)) return speed;
  throw refused('the model does not offer this speed', { providerId: provider.id, model, speed, expected: options.map(option => option.id) });
}
