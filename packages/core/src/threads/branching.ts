import { createHash } from 'node:crypto';
import type {
  AgentLetter,
  Attachment,
  Message,
  MessageId,
  MoveEnd,
  MoveNotice,
  PreviewReference,
  ThreadId,
  ThreadRewind,
  ThreadSummary,
  Turn,
  TurnId,
} from '@boite/contracts';
import { threadActive } from '@boite/contracts';
import type { Core } from '../core.ts';
import { getDriver } from '../drivers/index.ts';
import { NativeForkUnsupported } from '../drivers/native-fork.ts';
import type { ForkedSession } from '../drivers/types.ts';
import { invalidParams, refused } from '../errors.ts';
import { newId } from '../ids.ts';
import type { ThreadStore } from '../threads.ts';
import { MOVE_NOTE_PREFIX, moveNote } from './move.ts';
import { withLoad } from './records.ts';

type SessionPlan = Pick<ThreadSummary, 'sessionId' | 'sessionResumeAt'> & { session: ThreadRewind['session'] };

/** The suffix a fork's title takes after its source's. */
export const FORK_TITLE_SUFFIX = ' (fork)';

/**
 * Editing a sent prompt (`threads.rewind`) and branching a conversation
 * (`threads.fork`). Both leave the agent with exactly the history the thread
 * now shows. A driver that reports `TurnResult.checkpoint` (Claude) resumes its
 * own transcript at the last kept turn's entry, forked under a new session id
 * so the original transcript is never cut. Every other driver, and any turn
 * without a checkpoint, drops the native session: the next turn starts a fresh
 * one carrying the kept history, the path a change of account takes.
 */
export class ThreadBranching {
  constructor(private readonly core: Core, private readonly threads: ThreadStore) {}

  async rewind(threadId: ThreadId, messageId: MessageId): Promise<ThreadRewind> {
    const thread = this.threads.require(threadId);
    if (thread.agentSessionId) {
      throw refused('a persistent agent session takes its work through Agents and cannot be rewound', { threadId, field: 'threadId', expected: 'a conversation thread' });
    }
    if (thread.archived) throw refused('cannot rewind an archived thread', { threadId, field: 'threadId', expected: 'a thread that is not archived' });
    if (threadActive(thread.status) || this.threads.runner.handles.has(threadId)) {
      throw refused('this thread has a turn running or queued; stop it before editing a message', {
        threadId,
        reason: 'turn-in-flight',
        status: thread.status,
        expected: 'an idle thread',
      });
    }
    const rowid = this.core.journal.messageRowid(threadId, messageId);
    const message = rowid === null ? null : this.core.journal.getMessage(messageId);
    if (rowid === null || message === null) {
      throw refused(`message ${messageId} is not a message of thread ${threadId}`, { threadId, field: 'messageId', messageId, expected: 'a user message of this thread' });
    }
    if (message.role !== 'user') {
      throw refused(`message ${messageId} is a ${message.role} message; only a message the user sent can be edited`, {
        threadId,
        field: 'messageId',
        messageId,
        role: message.role,
        expected: 'user',
      });
    }

    // A live follow-up can cut inside a turn; its final checkpoint is then too late.
    const kept = this.core.journal.listMessagePage(threadId, { beforeRowid: rowid, limit: 1 }).messages[0] ?? null;
    const removed = this.core.journal.messageIdsFrom(threadId, rowid);
    const keptIsBoundary = kept !== null && this.lastTurnMessage(threadId, kept.turnId)?.id === kept.id;
    const movedBeforeSetup = firstMove(removed.messageIds.map(id => this.core.journal.getMessage(id)));
    const checkpoint = keptIsBoundary && movedBeforeSetup === null ? this.nativeForkCheckpoint(thread, kept!.turnId) : null;
    let native: ForkedSession | null = null;
    try {
      if (checkpoint) {
        const provider = this.core.providers.require(thread.providerId);
        const account = this.core.accounts.require(thread.accountId);
        const ctx = this.threads.contexts.makeSessionContext({ ...thread, sessionId: null, sessionResumeAt: null }, provider, account);
        try { native = await getDriver(provider.protocol).forkSession!(ctx, checkpoint); }
        catch (error) { if (!(error instanceof NativeForkUnsupported)) throw error; }
        const current = this.threads.require(threadId);
        if (current.updatedAt !== thread.updatedAt || current.selectionVersion !== thread.selectionVersion
          || current.sessionId !== thread.sessionId || current.sessionGeneration !== thread.sessionGeneration
          || current.providerId !== thread.providerId || current.accountId !== thread.accountId || current.cwd !== thread.cwd
          || this.core.journal.messageRowid(threadId, messageId) !== rowid
          || JSON.stringify(this.core.journal.getMessage(messageId)) !== JSON.stringify(message)
          || this.lastTurnMessage(threadId, kept!.turnId)?.id !== kept!.id
          || JSON.stringify(this.nativeForkCheckpoint(current, kept!.turnId)) !== JSON.stringify(checkpoint)) {
          throw refused('the source thread changed while preparing its rewind; retry the edit', { threadId, expected: 'the unchanged source boundary' });
        }
      }
      const result = await this.threads.codeCheckpoints.rewind(thread, removed.turnIds, messageId, files => {
      const current = this.threads.require(threadId);
      if (current.archived || current.cwd !== thread.cwd || threadActive(current.status) || current.updatedAt !== thread.updatedAt
        || current.selectionVersion !== thread.selectionVersion || current.sessionId !== thread.sessionId
        || current.sessionGeneration !== thread.sessionGeneration || current.providerId !== thread.providerId
        || current.accountId !== thread.accountId
        || (checkpoint && (JSON.stringify(this.nativeForkCheckpoint(current, kept!.turnId)) !== JSON.stringify(checkpoint)
          || this.lastTurnMessage(threadId, kept!.turnId)?.id !== kept!.id))
        || JSON.stringify(this.core.journal.getMessage(messageId)) !== JSON.stringify(message)
        || this.core.journal.messageRowid(threadId, messageId) !== rowid) {
        throw refused('this thread changed while restoring files; retry the edit', { field: 'threadId', threadId, expected: 'the unchanged idle thread' });
      }
      // The thread moved after the kept turn: its checkpoint belongs to the old
      // folder, and the notes that told the agent go with the removed messages.
      // The next one says it again, from where the kept history left the agent
      // to where the thread is now, however many moves came between.
      const moved = firstMove(removed.messageIds.map((id) => this.core.journal.getMessage(id)));
      const note = moved === null ? undefined : this.noteSince(thread, moved.from);
      const plan: SessionPlan = native ? { sessionId: native.sessionId, sessionResumeAt: null, session: 'native' }
        : kept === null || moved !== null ? fresh() : this.resumable(thread, kept.turnId, thread.cwd) ?? fresh();
      const next: ThreadSummary = {
        ...thread,
        sessionId: plan.sessionId,
        sessionResumeAt: plan.sessionResumeAt,
        // A new generation, as a change of account: nothing the old session
        // reports late can land on this one, and its totals start again.
        sessionGeneration: (thread.sessionGeneration ?? 0) + 1,
        context: null,
        promptCache: null,
        status: 'idle',
        updatedAt: Date.now(),
      };
      // The process that holds the whole session goes first, whatever it still runs.
      this.threads.releaseAgent(threadId);
      this.threads.agentState.noteBackground(threadId, []);
      this.threads.cards.clearQuestionsOf(threadId, true);
      this.threads.deferred.deferredAnswers.delete(threadId);
      this.threads.deferred.pendingWakes.delete(threadId);

      this.core.journal.append(
        {
          type: 'thread.rewound',
          threadId,
          version: 1,
          payload: {
            messageId,
            removedMessageIds: removed.messageIds,
            removedTurnIds: removed.turnIds,
            session: plan.session,
            sessionId: plan.sessionId,
            sessionResumeAt: plan.sessionResumeAt,
            previousSessionId: thread.sessionId,
          },
        },
        () => {
          this.core.journal.truncateMessages(threadId, rowid);
          this.core.journal.putThread(next);
          if (note) this.core.journal.setSetting(`${MOVE_NOTE_PREFIX}${threadId}`, note);
          else if (note === null) this.core.journal.deleteSetting(`${MOVE_NOTE_PREFIX}${threadId}`);
        },
      );
      this.core.bus.emit('message.truncated', { threadId, messageId });
      this.core.bus.emit('thread.updated', withLoad(this.core, this.threads.require(threadId)));
      const content = contentOf(message);
      return { thread: this.threads.get(threadId), ...content, session: plan.session, files };
      });
      await native?.release().catch(cleanup => this.core.log('error', `native rewind process cleanup failed: ${String(cleanup)}`, { threadId }));
      return result;
    } catch (error) {
      if (native) await native.discard().catch(cleanup => this.core.log('error', `native rewind cleanup failed: ${String(cleanup)}`, { threadId }));
      throw error;
    }
  }

  /**
   * A new thread with the history up to and including `messageId`. With
   * `worktree` it gets a git worktree of its own, made the way
   * `threads.create` makes one; the record is written only once git succeeded,
   * and a refusal after that removes the worktree again.
   */
  async fork(threadId: ThreadId, messageId: MessageId, worktree: boolean): Promise<ThreadSummary> {
    const source = this.threads.require(threadId);
    if (source.agentSessionId || source.projectId === null) {
      throw refused('a persistent agent session takes its work through Agents and cannot be forked', { threadId, field: 'threadId', expected: 'a conversation thread' });
    }
    const rowid = this.core.journal.messageRowid(threadId, messageId);
    const target = rowid === null ? null : this.core.journal.getMessage(messageId);
    if (rowid === null || target === null) {
      throw refused(`message ${messageId} is not a message of thread ${threadId}`, { threadId, field: 'messageId', messageId, expected: 'a message of this thread' });
    }
    if (target.state === 'streaming') {
      throw refused(`message ${messageId} is still being written; fork once it is complete`, { threadId, field: 'messageId', messageId, expected: 'a finished message' });
    }
    const project = this.core.projects.require(source.projectId);
    if (worktree && project.kind === 'drafts') {
      throw refused('a draft has no worktree: the drafts folder is not a git repository', { projectId: project.id, field: 'worktree', expected: false });
    }
    this.core.providers.require(source.providerId);
    this.core.accounts.require(source.accountId);

    const id = newId('thr_');
    const title = `${source.title}${FORK_TITLE_SUFFIX}`;
    const placed = worktree ? await this.core.worktrees.add(id, project) : null;
    try {
      return await this.writeFork(source, target, rowid, { id, title, cwd: placed?.path ?? source.cwd, branch: placed?.branch ?? source.branch, branchNamingPending: placed?.namingPending ?? false });
    } catch (error) {
      if (placed !== null) await this.core.worktrees.remove(id, project, placed);
      throw error;
    }
  }

  private async writeFork(source: ThreadSummary, target: Message, rowid: number, placed: { id: ThreadId; title: string; cwd: string; branch: string | null; branchNamingPending: boolean }): Promise<ThreadSummary> {
    const messages: Message[] = [];
    for (const message of this.core.journal.walkMessages(source.id)) {
      messages.push(message);
      if (message.id === target.id) break;
    }
    const lastOfTurn = [...this.core.journal.walkTurnMessages(source.id, target.turnId)].at(-1)?.id === target.id;
    // Codex can fork into the target cwd. Claude transcript cuts stay in their original folder.
    const checkpoint = lastOfTurn ? this.nativeForkCheckpoint(source, target.turnId) : null;
    let native: ForkedSession | null = null;
    let plan = lastOfTurn && placed.cwd === source.cwd ? this.resumable(source, target.turnId, placed.cwd) : null;
    try {
      if (checkpoint) {
        const provider = this.core.providers.require(source.providerId);
        const account = this.core.accounts.require(source.accountId);
        const targetThread = { ...source, id: placed.id, cwd: placed.cwd, sessionId: null, sessionResumeAt: null };
        const ctx = this.threads.contexts.makeSessionContext(targetThread, provider, account);
        try { native = await getDriver(provider.protocol).forkSession!(ctx, checkpoint); }
        catch (error) { if (!(error instanceof NativeForkUnsupported)) throw error; }
        if (native) plan = { sessionId: native.sessionId, sessionResumeAt: null, session: 'native' };
      }
      const current = this.threads.require(source.id);
      if (current.updatedAt !== source.updatedAt || current.selectionVersion !== source.selectionVersion
        || current.sessionId !== source.sessionId || current.sessionGeneration !== source.sessionGeneration
        || current.providerId !== source.providerId || current.accountId !== source.accountId || current.cwd !== source.cwd
        || this.core.journal.messageRowid(source.id, target.id) !== rowid
        || JSON.stringify(this.core.journal.getMessage(target.id)) !== JSON.stringify(target)
        || (checkpoint && JSON.stringify(this.nativeForkCheckpoint(current, target.turnId)) !== JSON.stringify(checkpoint))) {
        throw refused('the source thread changed while preparing its fork; retry the fork', { threadId: source.id, expected: 'the unchanged source boundary' });
      }
      const result = this.persistFork(source, messages, [...new Set(messages.map(message => message.turnId))].flatMap(id => {
        const turn = this.core.journal.getTurn(id); return turn ? [turn] : [];
      }), placed, plan, { threadId: source.id, messageId: target.id, turnId: target.turnId, rowid });
      await native?.release().catch(cleanup => this.core.log('error', `native fork process cleanup failed: ${String(cleanup)}`, { threadId: placed.id }));
      return result;
    } catch (error) {
      if (native) await native.discard().catch(cleanup => this.core.log('error', `native fork cleanup failed: ${String(cleanup)}`, { threadId: placed.id }));
      if (this.core.journal.getThread(placed.id) === null) this.core.agents.forget(placed.id);
      throw error;
    }
  }

  /** A side answer forks the bounded snapshot it actually saw, including an unfinished main turn. */
  forkSnapshot(source: ThreadSummary, snapshot: Message[], turns: Turn[], question: string, answer: string): ThreadSummary {
    if (source.agentSessionId || source.projectId === null) throw refused('threads.btw.fork.threadId: expected a conversation thread', { threadId: source.id });
    this.core.projects.require(source.projectId);
    this.core.providers.require(source.providerId);
    this.core.accounts.require(source.accountId);
    const now = Date.now(), turnId = newId('trn_');
    const sideTurn: Turn = { id: turnId, threadId: source.id, status: 'done', queuedAt: now, startedAt: now, finishedAt: now, usage: null, error: null };
    const exchange: Message[] = [
      { id: newId('msg_'), threadId: source.id, turnId, role: 'user', parts: [{ type: 'text', text: question }], state: 'complete', createdAt: now },
      { id: newId('msg_'), threadId: source.id, turnId, role: 'assistant', parts: [{ type: 'text', text: answer }], state: 'complete', createdAt: now },
    ];
    return this.persistFork(source, [...snapshot, ...exchange], [...turns.map(turn => ({ ...turn, checkpoint: null })), sideTurn], {
      id: newId('thr_'), title: `${source.title}${FORK_TITLE_SUFFIX}`, cwd: source.cwd, branch: source.branch, branchNamingPending: false,
    }, null, { threadId: source.id, messageId: snapshot.at(-1)?.id ?? null, turnId: snapshot.at(-1)?.turnId ?? null, sideQuestion: true });
  }

  private persistFork(source: ThreadSummary, messages: Message[], originals: Turn[], placed: { id: ThreadId; title: string; cwd: string; branch: string | null; branchNamingPending: boolean }, plan: SessionPlan | null, from: Record<string, unknown>): ThreadSummary {
    const now = Date.now();
    const thread: ThreadSummary = {
      id: placed.id,
      forkOrigin: { threadId: source.id, messageId: typeof from['messageId'] === 'string' ? from['messageId'] : null,
        turnId: typeof from['turnId'] === 'string' ? from['turnId'] : null, mode: plan?.session ?? 'seeded' },
      projectId: source.projectId,
      title: placed.title,
      titleSource: source.titleSource,
      providerId: source.providerId,
      accountId: source.accountId,
      model: source.model,
      effort: source.effort,
      speed: source.speed ?? null,
      cwd: placed.cwd,
      branch: placed.branch,
      branchNamingPending: placed.branchNamingPending,
      permissionMode: source.permissionMode,
      status: 'idle',
      unread: false,
      archived: false,
      pinned: false,
      sessionId: plan?.sessionId ?? null,
      ...(plan?.sessionResumeAt ? { sessionResumeAt: plan.sessionResumeAt } : {}),
      // Generation 1 with no session is what makes the first turn carry the
      // copied history into a fresh one (`TurnContexts.makeContext`).
      sessionGeneration: plan === null ? 1 : 0,
      selectionVersion: 0,
      load: null,
      context: null,
      createdAt: now,
      updatedAt: now,
    };
    const originalsById = new Map(originals.map(turn => [turn.id, turn]));
    const turnIds = new Map<TurnId, TurnId>();
    const turns: Turn[] = [];
    for (const message of messages) {
      if (turnIds.has(message.turnId)) continue;
      const id = newId('trn_');
      turnIds.set(message.turnId, id);
      const original = originalsById.get(message.turnId);
      if (!original) continue;
      const inFlight = original.status === 'queued' || original.status === 'running';
      turns.push({
        ...structuredClone(original),
        id,
        threadId: thread.id,
        // Still running on the source: here it is over, and whatever it does
        // next belongs to the source alone.
        status: inFlight ? 'stopped' : original.status,
        queueHold: null,
        startedAt: original.startedAt ?? original.queuedAt,
        finishedAt: original.finishedAt ?? now,
        // What the turn spent is the source's; counting it twice would double the usage history.
        usage: null,
      });
    }
    const copies: Message[] = messages.map((message) => ({
      ...structuredClone(message),
      id: newId('msg_'),
      threadId: thread.id,
      turnId: turnIds.get(message.turnId) ?? message.turnId,
      state: message.state === 'streaming' ? 'complete' : message.state,
    }));
    this.core.journal.append(
      {
        type: 'thread.forked',
        threadId: thread.id,
        version: 1,
        payload: { thread, from, session: plan?.session ?? 'seeded', messages: copies.length },
      },
      () => {
        this.core.journal.putThread(thread);
        for (const turn of turns) this.core.journal.putTurn(turn);
        for (const message of copies) this.core.journal.putMessage(message);
      },
    );
    const row = withLoad(this.core, this.threads.require(thread.id));
    this.core.bus.emit('thread.created', row);
    return row;
  }

  /** Return user-supplied conclusions as one durable coordination letter, never a Git merge. */
  async mergeBack(params: { threadId: ThreadId; summary: string; requestId: string }): Promise<AgentLetter> {
    const fork = this.threads.require(params.threadId);
    const origin = fork.forkOrigin;
    if (!origin || origin.threadId === fork.id) throw refused('threadId: expected a fork with a distinct recorded source', { threadId: fork.id });
    const source = this.core.journal.getThread(origin.threadId);
    if (!source) throw refused('fork source no longer exists', { threadId: origin.threadId, expected: 'an existing source thread' });
    if (source.archived) throw refused('fork source is archived', { threadId: source.id, expected: 'an unarchived source thread' });
    if (typeof params.summary !== 'string' || !params.summary.trim() || params.summary.length > 4000) throw invalidParams('summary: expected 1 to 4000 characters');
    if (typeof params.requestId !== 'string' || !params.requestId.trim() || params.requestId.length > 128) throw invalidParams('requestId: expected 1 to 128 characters');
    const requestId = `fork-return:${createHash('sha256').update(params.requestId).digest('hex')}`;
    const to = { coreId: this.core.coordination.identity().coreId, threadId: source.id };
    const fingerprint = createHash('sha256').update(JSON.stringify([to, params.summary, null])).digest('hex');
    const existing = this.core.journal.db.query('SELECT data,fingerprint FROM coordination_letters WHERE thread_id = ? AND request_id = ?').get(fork.id, requestId) as { data: string; fingerprint: string } | null;
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw refused('requestId already used for different content');
      // A response-loss retry after restart returns its receipt even when delivery is now paused.
      return JSON.parse(existing.data) as AgentLetter;
    }
    if (fork.archived) throw refused('fork is archived', { threadId: fork.id, expected: 'an unarchived fork' });
    const sender = this.core.coordination.config(fork.id), recipient = this.core.coordination.config(source.id);
    if (sender.mode === 'off' || sender.paused || recipient.mode === 'off') throw refused('fork return requires enabled coordination on both threads and an unpaused sender');
    if (fork.projectId !== source.projectId && !(sender.remote && recipient.remote)) throw refused('both threads must enable coordination across projects');
    // Coordination authenticates both actual threads and keeps their existing permission and wake policy.
    return await this.core.coordination.send({ threadId: fork.id, to, text: params.summary, requestId });
  }

  /** Indexed metadata existence checks: no provider load or transcript hydration. */
  nativeForkAvailable(thread: ThreadSummary): boolean {
    const provider = this.core.providers.require(thread.providerId);
    const codex = getDriver(provider.protocol).forkSession !== undefined;
    if (!codex && provider.protocol !== 'claude-sdk') return false;
    if (codex && (threadActive(thread.status) || this.threads.runner.handles.has(thread.id) || thread.sessionId === null)) return false;
    const nativeConditions = codex
      ? "AND t.status = 'done' AND json_extract(t.checkpoint, '$.sessionId') = ? AND json_extract(t.execution, '$.sessionGeneration') = ?"
      : "AND t.status IN ('done','stopped','error') AND (SELECT COUNT(*) FROM messages u WHERE u.thread_id = t.thread_id AND u.turn_id = t.id AND u.role = 'user') <= 1";
    return this.core.journal.db.query(`SELECT 1 FROM turns t WHERE t.thread_id = ?
      AND json_extract(t.checkpoint, '$.sessionId') IS NOT NULL AND length(json_extract(t.checkpoint, '$.entry')) > 0
      AND json_extract(t.execution, '$.providerId') = ? AND json_extract(t.execution, '$.accountId') = ?
      ${nativeConditions}
      AND (SELECT state FROM messages m WHERE m.thread_id = t.thread_id AND m.turn_id = t.id ORDER BY rowid DESC LIMIT 1) = 'complete'
      LIMIT 1`).get(thread.id, thread.providerId, thread.accountId, ...(codex ? [thread.sessionId!, thread.sessionGeneration ?? 0] : [])) !== null;
  }

  nativeRewindAvailable(thread: ThreadSummary): boolean {
    return this.nativeForkAvailable(thread);
  }

  private lastTurnMessage(threadId: ThreadId, turnId: TurnId): { id: string; state: string } | null {
    return this.core.journal.db.query('SELECT id,state FROM messages WHERE thread_id = ? AND turn_id = ? ORDER BY rowid DESC LIMIT 1').get(threadId, turnId) as { id: string; state: string } | null;
  }

  private nativeForkCheckpoint(thread: ThreadSummary, turnId: TurnId): { sessionId: string; entry: string } | null {
    const provider = this.core.providers.require(thread.providerId);
    if (!getDriver(provider.protocol).forkSession || threadActive(thread.status) || this.threads.runner.handles.has(thread.id)) return null;
    const turn = this.core.journal.getTurn(turnId);
    if (turn?.status !== 'done' || !turn.checkpoint || turn.checkpoint.sessionId !== thread.sessionId) return null;
    if (turn.execution?.providerId !== thread.providerId || turn.execution.accountId !== thread.accountId
      || turn.execution.sessionGeneration !== (thread.sessionGeneration ?? 0)) return null;
    const last = this.lastTurnMessage(thread.id, turnId);
    if (!last || last.state !== 'complete') return null;
    // Move notices name a different native cwd; a session from that folder cannot be adopted here.
    let past = false;
    for (const message of this.core.journal.walkMessages(thread.id)) {
      if (message.id === last.id) past = true;
      else if (past && firstMove([message]) !== null) return null;
    }
    return turn.checkpoint;
  }

  /**
   * The session plan that resumes `turnId`'s own checkpoint: the turn's session
   * cut at its last entry. Null when the turn left none, ran on another account
   * or provider, or is still under way.
   */
  private resumable(thread: ThreadSummary, turnId: TurnId, cwd: string): SessionPlan | null {
    if (this.core.providers.require(thread.providerId).protocol !== 'claude-sdk') return null;
    const turn = this.core.journal.getTurn(turnId);
    const checkpoint = turn?.checkpoint ?? null;
    if (turn === null || checkpoint === null || cwd !== thread.cwd) return null;
    if (turn.status === 'queued' || turn.status === 'running') return null;
    if (turn.execution?.accountId !== thread.accountId || turn.execution.providerId !== thread.providerId) return null;
    // Native checkpoints cover the provider's entire turn, including later input and output.
    // Message order cannot identify a precise native cut once user input joins mid-turn.
    let users = 0;
    for (const message of this.core.journal.walkTurnMessages(thread.id, turnId)) {
      if (message.role === 'user' && ++users > 1) return null;
    }
    return { sessionId: checkpoint.sessionId, sessionResumeAt: checkpoint.entry, session: 'native' };
  }

  /**
   * The note from `origin`, where the kept history last put the agent, to the
   * thread's folder now. It replaces a pending one, which starts later. Null
   * when the thread is back where the agent last knew it.
   */
  private noteSince(thread: ThreadSummary, origin: MoveEnd): MoveNotice | null {
    if (origin.cwd === thread.cwd) return null;
    const project = this.core.journal.getProject(thread.projectId ?? '');
    const here: MoveEnd = { projectId: thread.projectId ?? '', name: project?.name ?? thread.projectId ?? '', cwd: thread.cwd };
    return { from: origin, to: here, note: moveNote(origin, here, thread.branch), at: Date.now() };
  }
}

/** The earliest move notice the messages carry, a user's prompt or an agent's own line. */
function firstMove(messages: (Message | null)[]): MoveNotice | null {
  for (const message of messages) {
    for (const part of message?.parts ?? []) {
      if (part.type === 'text' && part.moved !== undefined) return part.moved;
    }
  }
  return null;
}

function fresh(): SessionPlan {
  return { sessionId: null, sessionResumeAt: null, session: 'seeded' };
}

/** The removed message as the composer takes it back: what the user typed, and what they attached. */
function contentOf(message: Message): Pick<ThreadRewind, 'prompt' | 'attachments' | 'previewReferences'> {
  let prompt = '';
  const attachments: Attachment[] = [];
  const previewReferences: PreviewReference[] = [];
  for (const part of message.parts) {
    if (part.type === 'text') {
      prompt += part.displayText ?? part.text;
      if (part.previewReferences) previewReferences.push(...structuredClone(part.previewReferences));
    } else if (part.type === 'image') {
      attachments.push({ kind: 'image', mimeType: part.mimeType, data: part.data, name: part.alt });
    } else if (part.type === 'file') {
      attachments.push({ kind: 'file', mimeType: part.mimeType, data: part.data, name: part.name });
    }
  }
  return { prompt, attachments, previewReferences };
}
