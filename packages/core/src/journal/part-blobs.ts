import type { Database } from 'bun:sqlite';
import { TOOL_OUTPUT_PREVIEW_CHARS } from '@boite/contracts';
import type { Message, MessagePart } from '@boite/contracts';

/**
 * Large values of a message part live in `part_blobs`, one row each, instead
 * of inside the message's `parts` JSON. A turn that read 90 screenshots held
 * 33 MiB in one row, and every write of that streaming message rewrote all of
 * it (about 770 ms each on a busy disk) while one text part grew.
 *
 * The stored part keeps every small field and names the moved ones under
 * `$blob`; reads put them back, so nothing outside the journal sees the
 * difference. Rows written before this keep their values inline and read as
 * they are. Text and thinking stay inline: SQL readers of answers use them.
 */
export const BLOB_MIN_CHARS = 32 * 1024;
const MARK = '$blob';

type Stored = MessagePart & { [MARK]?: string[] };

const FIELDS: Partial<Record<MessagePart['type'], readonly string[]>> = {
  tool: ['output', 'inputText'],
  file: ['data'],
  image: ['data'],
};

export function createPartBlobs(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS part_blobs (
      message_id TEXT NOT NULL, part_index INTEGER NOT NULL, field TEXT NOT NULL, thread_id TEXT NOT NULL, data TEXT NOT NULL, digest TEXT NOT NULL,
      PRIMARY KEY (message_id, part_index, field));
    CREATE INDEX IF NOT EXISTS part_blobs_thread ON part_blobs (thread_id);`);
}

/**
 * The JSON stored for part `index`, after writing its large values to
 * `part_blobs`. Earlier values of that part go first, so a value that shrank
 * leaves nothing behind.
 */
export function storePart(db: Database, message: Pick<Message, 'id' | 'threadId'>, index: number, part: MessagePart | undefined): string {
  db.query('DELETE FROM part_blobs WHERE message_id = ? AND part_index = ?').run(message.id, index);
  if (part === undefined || part === null) return 'null';
  const fields = FIELDS[part.type] ?? [];
  const values = part as unknown as Record<string, unknown>;
  const moved = fields.filter(field => typeof values[field] === 'string' && (values[field] as string).length >= BLOB_MIN_CHARS);
  if (moved.length === 0) return JSON.stringify(part);
  const insert = db.query('INSERT INTO part_blobs (message_id, part_index, field, thread_id, data, digest) VALUES (?, ?, ?, ?, ?, ?)');
  const stored: Record<string, unknown> = { ...values, [MARK]: moved };
  for (const field of moved) {
    const value = values[field] as string;
    insert.run(message.id, index, field, message.threadId, value, Bun.hash(value).toString(36));
    stored[field] = '';
  }
  return JSON.stringify(stored);
}

/** Every part's stored JSON, in order, as `JSON.stringify(parts)` would place them. */
export function storeParts(db: Database, message: Pick<Message, 'id' | 'threadId' | 'parts'>): string {
  db.query('DELETE FROM part_blobs WHERE message_id = ?').run(message.id);
  return `[${message.parts.map((part, index) => storePart(db, message, index, part)).join(',')}]`;
}

/** True when a stored `parts` text names moved values; a plain substring test, no parse. */
export function hasBlobs(parts: string): boolean {
  return parts.includes(`"${MARK}"`);
}

/**
 * Puts the moved values back. With `toolPreviews`, a finished tool's output
 * comes back as the bounded preview `previewToolOutputs` would make, read
 * from the start of its row, so a page never loads the whole screenshot.
 */
export function hydrate(db: Database, message: Message, toolPreviews = false): Message {
  if (!message.parts.some(part => part !== null && typeof part === 'object' && MARK in part)) return message;
  const full = db.query('SELECT part_index AS partIndex, field, data, digest FROM part_blobs WHERE message_id = ?');
  const preview = db.query(`SELECT part_index AS partIndex, field, digest,
      CASE WHEN field = 'output' THEN substr(data, 1, ${TOOL_OUTPUT_PREVIEW_CHARS}) ELSE data END AS data FROM part_blobs WHERE message_id = ?`);
  const rows = (toolPreviews ? preview : full).all(message.id) as { partIndex: number; field: string; data: string; digest: string }[];
  const values = new Map(rows.map(row => [`${row.partIndex}:${row.field}`, row]));
  const parts = message.parts.map((part, index) => {
    const moved = (part as Stored | null)?.[MARK];
    if (!moved) return part;
    const restored: Record<string, unknown> = { ...part };
    delete restored[MARK];
    for (const field of moved) restored[field] = values.get(`${index}:${field}`)?.data ?? '';
    if (toolPreviews && part.type === 'tool' && moved.includes('output') && part.status !== 'running') {
      restored.output = (restored.output as string).slice(0, TOOL_OUTPUT_PREVIEW_CHARS);
      restored.outputDeferred = true;
      previewDigests.set(restored, values.get(`${index}:output`)?.digest ?? '');
    } else if (toolPreviews && part.type === 'tool' && moved.includes('output')) {
      // A running tool's page keeps its whole output, as previewToolOutputs does.
      restored.output = (db.query("SELECT data FROM part_blobs WHERE message_id = ? AND part_index = ? AND field = 'output'")
        .get(message.id, index) as { data: string } | null)?.data ?? '';
    }
    return restored as MessagePart;
  });
  return { ...message, parts };
}

/**
 * The digest of the whole output behind each preview `hydrate` made. A resume
 * proof hashes it in place of the output, so a change past the preview still
 * changes the proof, as it did when pages carried the whole output.
 */
export const previewDigests = new WeakMap<object, string>();

/** One stored part with its moved values back, for a reader that took it from `json_each`. */
export function hydratePart(db: Database, messageId: string, index: number, part: MessagePart): MessagePart {
  const moved = (part as Stored)[MARK];
  if (!moved) return part;
  const restored: Record<string, unknown> = { ...part };
  delete restored[MARK];
  const read = db.query('SELECT data FROM part_blobs WHERE message_id = ? AND part_index = ? AND field = ?');
  for (const field of moved) restored[field] = (read.get(messageId, index, field) as { data: string } | null)?.data ?? '';
  return restored as MessagePart;
}

/** The moved values of `sourceId`, written again for its copy. */
export function copyBlobs(db: Database, sourceId: string, copy: Pick<Message, 'id' | 'threadId'>): void {
  db.query(`INSERT INTO part_blobs (message_id, part_index, field, thread_id, data, digest)
    SELECT ?, part_index, field, ?, data, digest FROM part_blobs WHERE message_id = ?`).run(copy.id, copy.threadId, sourceId);
}

/**
 * Moves the large values of one message written before `part_blobs` existed,
 * the first one after `afterRowid` whose row is at least `BLOB_MIN_CHARS`
 * bytes. Returns its rowid, or null once none is left. A message still held
 * open is left for later and its rowid returned as -1.
 */
export function moveInlineValues(db: Database, afterRowid: number, isOpen: (messageId: string) => boolean): number | null {
  const row = db.query('SELECT rowid AS rowid, id, thread_id AS threadId, parts FROM messages WHERE rowid > ? AND octet_length(parts) >= ? ORDER BY rowid LIMIT 1')
    .get(afterRowid, BLOB_MIN_CHARS) as { rowid: number; id: string; threadId: string; parts: string } | null;
  if (row === null) return null;
  if (isOpen(row.id)) return -1;
  const stored = JSON.parse(row.parts) as (Stored | null)[];
  const fields = (part: Stored | null) => FIELDS[part?.type as MessagePart['type']] ?? [];
  const inline = stored.some(part => part !== null && !part[MARK] && fields(part).some(field => {
    const value = (part as unknown as Record<string, unknown>)[field];
    return typeof value === 'string' && value.length >= BLOB_MIN_CHARS;
  }));
  if (inline) {
    db.transaction(() => {
      const texts = stored.map((part, index) => part === null || part[MARK] ? JSON.stringify(part) : storePart(db, { id: row.id, threadId: row.threadId }, index, part));
      db.query('UPDATE messages SET parts = ? WHERE id = ?').run(`[${texts.join(',')}]`, row.id);
    })();
  }
  return row.rowid;
}
