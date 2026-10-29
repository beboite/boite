import { RpcErrorCode, type CoreInfo, type ListCursor, type ThreadId, type ThreadSummary } from '@boite/contracts';
import { RpcFailure, type Client } from '../client';

/** A list read: the whole list, or the rows changed since the cursor sent. `cursor` is null from a core without `listChanges`. */
export type ThreadListAnswer =
  | { kind: 'full'; cursor: ListCursor | null; threads: ThreadSummary[] }
  | { kind: 'changes'; cursor: ListCursor; threads: ThreadSummary[]; removed: ThreadId[] };

/**
 * The sidebar's threads from `client`: only what changed since `since` when
 * the core keeps a change log (`features.listChanges`), else the whole list as
 * before. A core that announced it but refuses the call answers whole too,
 * with no error shown.
 */
export async function readThreadList(client: Client, core: CoreInfo | null, since: ListCursor | null): Promise<ThreadListAnswer> {
  if (core?.features?.listChanges !== true) return { kind: 'full', cursor: null, threads: await client.call('threads.list', {}) };
  try {
    return await client.call('threads.listChanges', since === null ? {} : { since });
  } catch (error) {
    if (!(error instanceof RpcFailure) || (error.code !== RpcErrorCode.MethodNotFound && error.code !== RpcErrorCode.InvalidParams && error.code !== RpcErrorCode.Refused)) throw error;
    return { kind: 'full', cursor: null, threads: await client.call('threads.list', {}) };
  }
}

/**
 * The held rows brought up to a `changes` answer: a changed row takes its
 * place, a new one comes last, a removed one goes, and a row the answer left
 * out keeps its fields but has no load, since every thread with running
 * processes is in the answer.
 */
export function applyThreadChanges(held: readonly ThreadSummary[], threads: readonly ThreadSummary[], removed: readonly ThreadId[]): ThreadSummary[] {
  const changed = new Map(threads.map(thread => [thread.id, thread]));
  const gone = new Set(removed);
  const rows: ThreadSummary[] = [];
  for (const row of held) {
    if (gone.has(row.id)) continue;
    const next = changed.get(row.id);
    if (next) {
      rows.push(next);
      changed.delete(row.id);
    } else rows.push(row.load == null ? row : { ...row, load: null });
  }
  rows.push(...changed.values());
  return rows;
}
