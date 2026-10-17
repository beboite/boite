import type { Database } from 'bun:sqlite';

/**
 * Event types nothing reads back: the message row holds their content. Their
 * trail keeps the shape and the start of each long string, not a second copy
 * of every tool output, screenshot and published file, and only for
 * `TRAIL_RETENTION_MS`.
 */
export const TRAIL_ONLY = new Set(['message.started', 'message.part', 'artifact.published']);
/**
 * Of those, the types no longer written at all: `message.part` was 570 MiB and
 * 467,073 rows of a 4.4 GB journal (2026-10-17), one INSERT per part change.
 */
export const UNWRITTEN = new Set(['message.part', 'artifact.published']);
export const TRAIL_TEXT_CHARS = 1024;

export function trailOf(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length <= TRAIL_TEXT_CHARS ? value : `${value.slice(0, TRAIL_TEXT_CHARS)}[${value.length - TRAIL_TEXT_CHARS} more characters]`;
  }
  if (Array.isArray(value)) return value.map(trailOf);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, trailOf(entry)]));
  }
  return value;
}

/**
 * Deletes the trail events (`TRAIL_ONLY`) written before `before` among the
 * `limit` events after id `afterId`, stopping at the first event that is not
 * older: ids grow with time, so the walk reads each event's id and time once,
 * never a payload, and no daily pass goes back over what an earlier one
 * passed. Returns the last id passed and whether the walk reached the events
 * still kept.
 */
export function pruneTrail(db: Database, afterId: number, before: number, limit: number): { through: number; done: boolean } {
  const rows = db.query('SELECT id, ts FROM events WHERE id > ? ORDER BY id LIMIT ?').all(afterId, limit) as { id: number; ts: number }[];
  let through = afterId, done = rows.length < limit;
  for (const row of rows) {
    if (row.ts >= before) { done = true; break; }
    through = row.id;
  }
  if (through > afterId) {
    db.query('DELETE FROM events WHERE id > ? AND id <= ? AND ts < ? AND type IN (SELECT value FROM json_each(?))')
      .run(afterId, through, before, JSON.stringify([...TRAIL_ONLY]));
  }
  return { through, done };
}
