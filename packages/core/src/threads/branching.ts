import type {
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
import { refused } from '../errors.ts';
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
    return this.threads.codeCheckpoints.rewind(thread, removed.turnIds, messageId, files => {
      const current = this.threads.require(threadId);
      if (current.archived || current.cwd !== thread.cwd || threadActive(current.status) || current.updatedAt !== thread.updatedAt || this.core.journal.messageRowid(threadId, messageId) !== rowid) {
        throw refused('this thread changed while restoring files; retry the edit', { field: 'threadId', threadId, expected: 'the unchanged idle thread' });
      }
      // The thread moved after the kept turn: its checkpoint belongs to the old
      // folder, and the notes that told the agent go with the removed messages.
      // The next one says it again, from where the kept history left the agent
      // to where the thread is now, however many moves came between.
      const moved = firstMove(removed.messageIds.map((id) => this.core.journal.getMessage(id)));
      const note = moved === null ? undefined : this.noteSince(thread, moved.from);
      const plan = kept === null || moved !== null ? fresh() : this.resumable(thread, kept.turnId, thread.cwd) ?? fresh();
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
      this.threads.deferred.consumed.delete(threadId);
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
      return this.writeFork(source, target, rowid, { id, title, cwd: placed?.path ?? source.cwd, branch: placed?.branch ?? source.branch, branchNamingPending: placed?.namingPending ?? false });
    } catch (error) {
      if (placed !== null) await this.core.worktrees.remove(id, project, placed);
      throw error;
    }
  }

  private writeFork(source: ThreadSummary, target: Message, rowid: number, placed: { id: ThreadId; title: string; cwd: string; branch: string | null; branchNamingPending: boolean }): ThreadSummary {
    const messages: Message[] = [];
    for (const message of this.core.journal.walkMessages(source.id)) {
      messages.push(message);
      if (message.id === target.id) break;
    }
    const lastOfTurn = [...this.core.journal.walkTurnMessages(source.id, target.turnId)].at(-1)?.id === target.id;
    // The transcript lives under the folder the agent ran in: a worktree is
    // another folder, so it starts fresh with the history instead.
    const plan = lastOfTurn && placed.cwd === source.cwd ? this.resumable(source, target.turnId, placed.cwd) : null;
    return this.persistFork(source, messages, [...new Set(messages.map(message => message.turnId))].flatMap(id => {
      const turn = this.core.journal.getTurn(id); return turn ? [turn] : [];
    }), placed, plan, { threadId: source.id, messageId: target.id, rowid });
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
    }, null, { threadId: source.id, sideQuestion: true });
  }

  private persistFork(source: ThreadSummary, messages: Message[], originals: Turn[], placed: { id: ThreadId; title: string; cwd: string; branch: string | null; branchNamingPending: boolean }, plan: SessionPlan | null, from: Record<string, unknown>): ThreadSummary {
    const now = Date.now();
    const thread: ThreadSummary = {
      id: placed.id,
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

  /**
   * The session plan that resumes `turnId`'s own checkpoint: the turn's session
   * cut at its last entry. Null when the turn left none, ran on another account
   * or provider, or is still under way.
   */
  private resumable(thread: ThreadSummary, turnId: TurnId, cwd: string): SessionPlan | null {
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
