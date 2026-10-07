import type { Database } from 'bun:sqlite';

/*
 * The `media_previews` rows: the blur of each deferred picture by message and
 * part, and part -1 once every picture of a message was looked at. Derived
 * from the messages, so nothing here writes an event.
 */

/**
 * Ids of up to `limit` messages on each side of `rowid`, or the last `limit`
 * when it is null, without reading a part: what `MediaPreviews.warm` walks.
 */
export function messageIdsNear(db: Database, threadId: string, rowid: number | null, limit: number): string[] {
  const rows = rowid === null
    ? db.query('SELECT id FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT ?').all(threadId, limit)
    : [
      ...db.query('SELECT id FROM messages WHERE thread_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?').all(threadId, rowid, limit),
      ...db.query('SELECT id FROM messages WHERE thread_id = ? AND rowid >= ? ORDER BY rowid LIMIT ?').all(threadId, rowid, limit),
    ];
  return (rows as { id: string }[]).map(row => row.id);
}

/** Those of `messageIds` whose pictures were never all looked at. */
export function unscannedMedia(db: Database, messageIds: string[]): string[] {
  const scanned = db.query('SELECT 1 FROM media_previews WHERE message_id = ? AND part_index = -1');
  return messageIds.filter(id => scanned.get(id) === null);
}

/** The blur of each picture of a message, by part; null for one that cannot have any. */
export function mediaPreviews(db: Database, messageId: string): Map<number, string | null> {
  const rows = db.query('SELECT part_index AS part, preview FROM media_previews WHERE message_id = ? AND part_index >= 0').all(messageId) as { part: number; preview: string | null }[];
  return new Map(rows.map(row => [row.part, row.preview]));
}

/** Part -1 marks the message looked at. Nothing is written for a message that left its thread meanwhile. */
export function putMediaPreview(db: Database, threadId: string, messageId: string, partIndex: number, preview: string | null): void {
  db.query('INSERT OR REPLACE INTO media_previews (message_id, part_index, thread_id, preview) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE id = ? AND thread_id = ?)')
    .run(messageId, partIndex, threadId, preview, messageId, threadId);
}

/** The WebP copy the timeline draws: its bytes, empty when the original is lighter, or null when not made yet. */
export function mediaDisplay(db: Database, messageId: string, partIndex: number): Uint8Array | null {
  const row = db.query('SELECT data FROM media_displays WHERE message_id = ? AND part_index = ?').get(messageId, partIndex) as { data: Uint8Array } | null;
  return row === null ? null : row.data;
}

/** Nothing is written for a message that left its thread meanwhile. */
export function putMediaDisplay(db: Database, threadId: string, messageId: string, partIndex: number, data: Uint8Array): void {
  db.query('INSERT OR REPLACE INTO media_displays (message_id, part_index, thread_id, data) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE id = ? AND thread_id = ?)')
    .run(messageId, partIndex, threadId, data, messageId, threadId);
}
