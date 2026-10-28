/**
 * What a child's finished turn means, for every owner of child threads:
 * delegation letters, workflow steps. A turn that ends on background work the
 * agent will be woken by is a checkpoint; only the turn after that work is its
 * final result.
 */
import { BACKGROUND_WAKE_GRACE_MS, delegationAnswerable as answerable } from '@boite/contracts';
import type { BackgroundTask, Turn } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf } from '../errors.ts';

export type ChildEnd =
  /** A compaction or cache keepalive: no step of the task. */
  | { kind: 'maintenance' }
  /** Ended to wait on its own background work: not done, and its worktree is still in use. */
  | { kind: 'checkpoint'; live: BackgroundTask[] }
  | { kind: 'final' };

/** A child's last turn of its task, past compactions and cache keepalives. */
export function taskTurn(core: Core, threadId: string): Turn | null {
  const row = core.journal.db.query("SELECT id FROM turns WHERE thread_id = ? AND COALESCE(json_extract(execution, '$.operation'), '') NOT IN ('compact', 'keepalive') ORDER BY rowid DESC LIMIT 1").get(threadId) as { id: string } | null;
  return row ? core.journal.getTurn(row.id) : null;
}

export function childEnd(core: Core, turn: Turn): ChildEnd {
  if (turn.execution?.operation === 'compact' || turn.execution?.operation === 'keepalive') return { kind: 'maintenance' };
  const live = turn.status === 'done' ? core.threads.agentState.background.get(turn.threadId) ?? [] : [];
  return live.length > 0 ? { kind: 'checkpoint', live } : { kind: 'final' };
}

/**
 * The background work a child's checkpoint waited on, once all of it
 * completed and the wake grace passed with no turn after it; null otherwise.
 * Some agents report a task's end without answering it (ACP commands), so a
 * success can leave the checkpoint as the child's last word.
 */
export function unwoken(core: Core, threadId: string): string | null {
  const thread = core.journal.getThread(threadId);
  if (thread?.status !== 'idle' || thread.archived || (core.threads.agentState.background.get(threadId) ?? []).length > 0) return null;
  const turn = taskTurn(core, threadId);
  if (turn?.status !== 'done' || turn.finishedAt === null) return null;
  const end = turn.finishedAt;
  const ended = core.threads.agentState.backgroundHistory.endedAfter(threadId, end).filter(task => task.startedAt <= end);
  if (ended.length === 0 || ended.some(task => task.state !== 'completed') || Date.now() < Math.max(...ended.map(task => task.finishedAt ?? end)) + BACKGROUND_WAKE_GRACE_MS) return null;
  return [...new Set(ended.map(task => task.description.trim() || task.kind))].join(', ');
}

/** Asks that child for the final result its checkpoint promised; the error when no turn could start. */
export function askFinal(core: Core, threadId: string, tasks: string): string | null {
  try {
    core.threads.startTurn(threadId, `Your background work (${tasks}) completed, but no turn of yours followed it, so your last answer is still a checkpoint. Check how that work ended and give your final result now.`, [], undefined, 'delegation', undefined, undefined, 'Background work completed: final result asked');
    return null;
  } catch (error) { return messageOf(error); }
}

/** The open asynchronous questions of a delegated agent that is over or stopped. */
export function closeQuestions(core: Core, threadId: string, by: string): void {
  for (const question of core.threads.listQuestions(threadId)) {
    // A blocking one goes with its turn; only an asynchronous card outlives it.
    if (!answerable(question) || question.async !== true) continue;
    try { core.threads.skipQuestion({ threadId, questionId: question.id }, by); } catch { /* Already closed by a nested settle. */ }
  }
}
