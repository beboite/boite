import type { Database } from 'bun:sqlite';

/**
 * When the user's current request started: the last turn the user opened,
 * skipping the turns Boite opened to carry it on, as `continuesRequest` in the
 * contracts reads them. When only such turns ever ran, the first of them
 * stands in, as `requestStarts` does. Null when no turn of the thread started.
 */
export function requestSince(db: Database, threadId: string): number | null {
  const row = db
    .query(`SELECT started_at AS since FROM turns
      WHERE thread_id = ? AND started_at IS NOT NULL
        AND (execution IS NULL OR (
          COALESCE(json_extract(execution, '$.operation'), '') NOT IN ('background', 'delegation', 'coordination', 'resume')
          AND json_extract(execution, '$.automatic') IS NOT 1))
      ORDER BY queued_at DESC, rowid DESC LIMIT 1`)
    .get(threadId) as { since: number } | null;
  if (row) return row.since;
  const first = db
    .query('SELECT MIN(started_at) AS since FROM turns WHERE thread_id = ?')
    .get(threadId) as { since: number | null } | null;
  return first?.since ?? null;
}
