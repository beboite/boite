import type {
  Attachment,
  Message,
  MessageId,
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

  rewind(threadId: ThreadId, messageId: MessageId): ThreadRewind {
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

    // A user message opens its turn, so what stays ends on a whole turn.
    const kept = this.core.journal.listMessagePage(threadId, { beforeRowid: rowid, limit: 1 }).messages[0] ?? null;
    const plan = kept === null ? fresh() : this.resumable(thread, kept.turnId, thread.cwd) ?? fresh();
    const removed = this.core.journal.messageIdsFrom(threadId, rowid);
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
      },
    );
    this.core.bus.emit('message.truncated', { threadId, messageId });
    this.core.bus.emit('thread.updated', withLoad(this.core, this.threads.require(threadId)));
    const content = contentOf(message);
    return { thread: this.threads.get(threadId), ...content, session: plan.session };
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
    const placed = worktree ? await this.core.worktrees.add(id, project, title) : null;
    try {
      return this.writeFork(source, target, rowid, { id, title, cwd: placed?.path ?? source.cwd, branch: placed?.branch ?? source.branch });
    } catch (error) {
      if (placed !== null) await this.core.worktrees.remove(id, project, placed);
      throw error;
    }
  }

  private writeFork(source: ThreadSummary, target: Message, rowid: number, placed: { id: ThreadId; title: string; cwd: string; branch: string | null }): ThreadSummary {
    const messages: Message[] = [];
    for (const message of this.core.journal.walkMessages(source.id)) {
      messages.push(message);
      if (message.id === target.id) break;
    }
    const lastOfTurn = [...this.core.journal.walkTurnMessages(source.id, target.turnId)].at(-1)?.id === target.id;
    // The transcript lives under the folder the agent ran in: a worktree is
    // another folder, so it starts fresh with the history instead.
    const plan = lastOfTurn && placed.cwd === source.cwd ? this.resumable(source, target.turnId, placed.cwd) : null;
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
    const turnIds = new Map<TurnId, TurnId>();
    const turns: Turn[] = [];
    for (const message of messages) {
      if (turnIds.has(message.turnId)) continue;
      const id = newId('trn_');
      turnIds.set(message.turnId, id);
      const original = this.core.journal.getTurn(message.turnId);
      if (original === null) continue;
      const inFlight = original.status === 'queued' || original.status === 'running';
      turns.push({
        ...original,
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
        payload: { thread, from: { threadId: source.id, messageId: target.id, rowid }, session: plan?.session ?? 'seeded', messages: copies.length },
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
    return { sessionId: checkpoint.sessionId, sessionResumeAt: checkpoint.entry, session: 'native' };
  }
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
