import type { Database } from 'bun:sqlite';
import type { ThreadSummary } from '@boite/contracts';
import { toThread, type ThreadRow } from './rows.ts';

/** Whole thread rows a client can see, with the time of their last prompt. Callers add `AND ...` filters. */
export const VISIBLE_THREADS = `SELECT *,
  EXISTS (SELECT 1 FROM threads parent WHERE parent.id = threads.parent_thread_id AND parent.agent_session_id IS NOT NULL) AS parent_is_bot,
  (SELECT MAX(created_at) FROM messages WHERE thread_id = threads.id AND role = 'user') AS last_user_message_at
  FROM threads WHERE id NOT IN (SELECT thread_id FROM thread_deletions)`;

/**
 * Visible threads matching `filter`, in creation order. Every read of whole
 * threads goes through here, so the deleted-thread filter and the last-prompt
 * column stay the same whatever the filter.
 */
export function threadsWhere(db: Database, filter: string, ...params: string[]): ThreadSummary[] {
  return (db.query(`${VISIBLE_THREADS} ${filter} ORDER BY rowid`).all(...params) as ThreadRow[]).map(toThread);
}

/** Current native sessions remain reserved while deleted threads are recoverable, children included. */
export function sessionThreads(db: Database): { id: string; sessionId: string }[] {
  return db.query('SELECT id, session_id AS sessionId FROM threads WHERE session_id IS NOT NULL').all() as { id: string; sessionId: string }[];
}

export function writeThread(db: Database, thread: ThreadSummary): void {
  db.query(
    `INSERT OR REPLACE INTO threads
     (id, project_id, title, title_source, provider_id, account_id, model, effort, cwd, branch, permission_mode, status, unread, archived, pinned, session_id, context, created_at, updated_at, session_generation, selection_version, speed, parent_thread_id, prompt_cache, agent_session_id, session_resume_at, title_state, branch_naming_pending, fork_origin, done_at, incognito, archived_at, context_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    thread.id,
    thread.projectId,
    thread.title,
    thread.titleSource,
    thread.providerId,
    thread.accountId,
    thread.model,
    thread.effort,
    thread.cwd,
    thread.branch,
    thread.permissionMode,
    thread.status,
    thread.unread ? 1 : 0,
    thread.archived ? 1 : 0,
    thread.pinned ? 1 : 0,
    thread.sessionId,
    thread.context === null ? null : JSON.stringify(thread.context),
    thread.createdAt,
    thread.updatedAt,
    thread.sessionGeneration ?? 0,
    thread.selectionVersion ?? 0,
    thread.speed ?? null,
    thread.parentThreadId ?? null,
    thread.promptCache ? JSON.stringify(thread.promptCache) : null,
    thread.agentSessionId ?? null,
    thread.sessionResumeAt ?? null,
    thread.titleState ? JSON.stringify(thread.titleState) : null,
    thread.branchNamingPending === true ? 1 : 0,
    thread.forkOrigin ? JSON.stringify(thread.forkOrigin) : null,
    thread.doneAt ?? null,
    thread.incognito ? 1 : 0,
    thread.archived ? (thread.archivedAt ?? null) : null, thread.contextMode ? JSON.stringify(thread.contextMode) : null,
  );
}
