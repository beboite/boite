import type { Database } from 'bun:sqlite';

/*
 * The `media_previews` rows: the blur of each deferred picture by message and
 * part. Derived from the messages, so nothing here writes an event.
 */

/** The blur of each picture of a message, by part; null for one that cannot have any. */
export function mediaPreviews(db: Database, messageId: string): Map<number, string | null> {
  const rows = db.query('SELECT part_index AS part, preview FROM media_previews WHERE message_id = ? AND part_index >= 0').all(messageId) as { part: number; preview: string | null }[];
  return new Map(rows.map(row => [row.part, row.preview]));
}

/** Nothing is written for a message that left its thread meanwhile. */
export function putMediaPreview(db: Database, threadId: string, messageId: string, partIndex: number, preview: string | null): void {
  db.query('INSERT OR REPLACE INTO media_previews (message_id, part_index, thread_id, preview) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE id = ? AND thread_id = ?)')
    .run(messageId, partIndex, threadId, preview, messageId, threadId);
}

/**
 * The WebP copy the timeline draws: its bytes, empty when the original is
 * lighter, or null when not made yet. The thread is part of the key, so a
 * found copy is also proof that the message is one of that thread's.
 */
export function mediaDisplay(db: Database, threadId: string, messageId: string, partIndex: number): Uint8Array | null {
  const row = db.query('SELECT data FROM media_displays WHERE message_id = ? AND part_index = ? AND thread_id = ?').get(messageId, partIndex, threadId) as { data: Uint8Array } | null;
  return row === null ? null : row.data;
}

/** Nothing is written for a message that left its thread meanwhile. */
export function putMediaDisplay(db: Database, threadId: string, messageId: string, partIndex: number, data: Uint8Array): void {
  db.query('INSERT OR REPLACE INTO media_displays (message_id, part_index, thread_id, data) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE id = ? AND thread_id = ?)')
    .run(messageId, partIndex, threadId, data, messageId, threadId);
}
