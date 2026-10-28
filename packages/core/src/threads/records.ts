import { archiveState } from '../merged-pr-archive-state.ts';
import { worktreeRemovalOf } from '../worktree-cleanup-state.ts';
import { backgroundWait, pullRequestWatchWaits } from '@boite/contracts';
import type { BackgroundTask, BackgroundWait, MessageId, MessagePart, MoveNotice, RpcParams, ThreadId, ThreadSummary } from '@boite/contracts';
import type { Core } from '../core.ts';
import { notFound } from '../errors.ts';

/** The journalled tool call a client names by message and tool id, in a thread it can read. */
function journalledTool(core: Core, params: { threadId: ThreadId; messageId: MessageId; toolId: string }): Extract<MessagePart, { type: 'tool' }> {
  core.threads.require(params.threadId);
  // Only this tool's output is read, not every screenshot of its message.
  const found = core.journal.messagePart(params.messageId, part => part.type === 'tool' && part.toolId === params.toolId);
  if (!found || found.message.threadId !== params.threadId) throw notFound(`message ${params.messageId} is not a message of thread ${params.threadId}`, params);
  const part = found.part;
  if (!part || part.type !== 'tool') throw notFound(`tool ${params.toolId} is not a tool of message ${params.messageId}`, params);
  return part;
}

export function readToolOutput(core: Core, params: RpcParams<'messages.toolOutput'>): { output: string | null } {
  return { output: journalledTool(core, params).output };
}

/** The whole call, for a card whose page deferred its output, input or documents. */
export function readToolPart(core: Core, params: RpcParams<'messages.toolPart'>): { part: Extract<MessagePart, { type: 'tool' }> } {
  return { part: journalledTool(core, params) };
}

// The thread row as every part of the store writes it: one event, the row, and the clients told.
// Its status has one writer, `threads/lifecycle.ts`.

export function saveThread(core: Core, thread: ThreadSummary, eventType: string): ThreadSummary {
  const next: ThreadSummary = { ...thread, updatedAt: Date.now() };
  core.journal.append({ type: eventType, threadId: next.id, version: 1, payload: next }, () => {
    core.journal.putThread(next);
  });
  const summary = withLoad(core, next);
  core.bus.emit('thread.updated', summary);
  return summary;
}

/** The journal setting holding the note a thread's next message carries to its agent (`threads/move.ts`). */
export const MOVE_NOTE_PREFIX = 'move-note:';

/** The note waiting for a thread's next message, or null. */
export function pendingMoveNote(core: Core, threadId: ThreadId): MoveNotice | null {
  const value = core.journal.getSetting(`${MOVE_NOTE_PREFIX}${threadId}`) as MoveNotice | undefined;
  return value ?? null;
}

/** The row as a client sees it: the stored summary plus what only lives in memory. */
export function withLoad(core: Core, thread: ThreadSummary): ThreadSummary {
  const busy = thread.status === 'running' || thread.status === 'waiting';
  const archiveReason = thread.archived ? archiveState(core.journal, thread.id).reason : undefined;
  // Archive summaries are built before commit; what an archive puts away on
  // commit (`putAway`: background work, held answers, open cards) stays in memory
  // until then so a rollback keeps it, but a row put away has none. A merged PR's
  // Done only hides the row: its prompt still finishes and shows what it runs.
  const putAway = thread.archived && archiveReason === undefined;
  const tasks = putAway ? [] : core.threads?.agentState.background.get(thread.id) ?? [];
  const watches = core.pullRequestWatches?.of(thread.id) ?? [];
  return {
    ...thread,
    archiveReason,
    worktreeRemoved: thread.branch === null ? undefined : worktreeRemovalOf(core.journal, thread) ?? undefined,
    load: core.procs.loadOf(thread.id),
    runningSince: busy ? core.journal.runningSince(thread.id) : null,
    // A watch still waiting on checks carries the request on, like a monitor.
    requestSince: busy || tasks.length > 0 || watches.some(pullRequestWatchWaits) ? core.journal.requestSince(thread.id) : null,
    progress: busy ? core.threads?.progress?.get(thread.id) ?? null : null,
    backgroundWork: tasks.length === 0 ? null : { kinds: tasks.map(task => task.kind), since: Math.min(...tasks.map(task => task.startedAt)) },
    backgroundWait: thread.parentThreadId ? backgroundWaitOf(core, thread, tasks) : null,
    // An archived row, put away or done, has no move to apply.
    pendingMove: thread.archived ? null : core.threads?.moves?.pendingOf(thread.id) ?? null,
    moveNote: thread.agentSessionId ? null : pendingMoveNote(core, thread.id),
    pendingAnswers: putAway ? [] : [...(core.threads?.deferred?.deferredAnswers.get(thread.id) ?? [])],
    openQuestions: putAway ? 0 : core.threads?.cards?.openAsyncCount(thread.id) ?? 0,
    retry: core.threads?.runner?.retryOf(thread.id) ?? core.threads?.resumes?.retryOf(thread.id) ?? null,
    pullRequestWatches: watches,
  };
}

/**
 * A delegated agent at rest that its own background work will wake, or that
 * this work left behind (`backgroundWait`). Two indexed reads per idle child.
 */
export function backgroundWaitOf(core: Core, thread: ThreadSummary, live: BackgroundTask[]): BackgroundWait | null {
  if (thread.status === 'queued' || !core.threads) return null;
  const row = core.journal.db.query("SELECT id FROM turns WHERE thread_id = ? AND COALESCE(json_extract(execution, '$.operation'), '') NOT IN ('compact', 'keepalive') ORDER BY rowid DESC LIMIT 1").get(thread.id) as { id: string } | null;
  const lastTurn = row ? core.journal.getTurn(row.id) : null;
  if (lastTurn?.status !== 'done' || lastTurn.finishedAt === null) return null;
  const history = live.length > 0 ? [] : core.threads.agentState.backgroundHistory.endedAfter(thread.id, lastTurn.finishedAt);
  // The last turn is the truth: `turn.finished` is heard before the row's status turns idle.
  return backgroundWait({ status: 'idle', lastTurn, live, history, now: Date.now() });
}
