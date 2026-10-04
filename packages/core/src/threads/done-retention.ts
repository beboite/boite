import { RpcErrorCode, DEFAULT_THREAD_DONE_RETENTION_DAYS } from '@boite/contracts';
import type { Core } from '../core.ts';
import { RpcFailure } from '../errors.ts';
import { assertIdleFamily } from './completion.ts';

/** Done expiry uses its own date, independent of later reads, renames and turn settlement. */
export async function deleteExpiredDoneThreads(core: Core): Promise<void> {
  const days = core.settings.get().threadDoneRetentionDays ?? DEFAULT_THREAD_DONE_RETENTION_DAYS;
  if (days === 0 || core.stopping) return;
  const rows = core.journal.db.query(`SELECT id FROM threads WHERE archived = 1 AND done_at <= ?
    AND parent_thread_id IS NULL AND agent_session_id IS NULL
    AND id NOT IN (SELECT thread_id FROM thread_deletions) ORDER BY done_at`)
    .all(Date.now() - days * 86_400_000) as { id: string }[];
  let deleted = 0;
  for (const { id } of rows) {
    if (core.stopping) return;
    // Settings and rows can change while another family's processes stop.
    const currentDays = core.settings.get().threadDoneRetentionDays ?? DEFAULT_THREAD_DONE_RETENTION_DAYS;
    const thread = core.journal.getThread(id);
    if (currentDays === 0 || !thread?.archived || thread.doneAt == null
      || thread.doneAt > Date.now() - currentDays * 86_400_000 || core.threads.isRemoving(id)) continue;
    try { assertIdleFamily(core, id); }
    catch (error) {
      if (error instanceof RpcFailure && error.code === RpcErrorCode.Refused) continue;
      throw error;
    }
    await core.threads.remove(id);
    if (++deleted >= 100) return;
  }
}

/** One pass at a time; startup catches up after offline time and shutdown waits for owned work. */
export function scheduleDoneRetention(core: Core): () => Promise<void> {
  let pending: Promise<void> | null = null;
  let stopped = false;
  const pass = () => {
    if (stopped || pending) return;
    pending = deleteExpiredDoneThreads(core).catch(error => {
      core.log('error', `done thread retention: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { pending = null; });
  };
  const startup = setTimeout(pass, 0);
  const timer = setInterval(pass, 60_000);
  startup.unref();
  timer.unref();
  return async () => {
    stopped = true;
    clearTimeout(startup);
    clearInterval(timer);
    await pending;
  };
}
