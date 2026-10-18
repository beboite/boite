import type { Database } from 'bun:sqlite';
import { TOOL_OUTPUT_INLINE_CHARS, TOOL_OUTPUT_PREVIEW_CHARS } from '@boite/contracts';
import type { Message, MessagePart } from '@boite/contracts';
import { runWrite } from './statements.ts';

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
/**
 * A tool output moves out from this size: outputs of 4 to 32 KiB were 40 % of
 * the bytes of the large `messages` rows (2026-10-17 journal), and no SQL
 * reader looks into a tool output.
 */
export const TOOL_OUTPUT_BLOB_MIN_CHARS = 4 * 1024;
/**
 * `codec` of a `part_blobs` row: 0 is the UTF-8 text in `data`, 1 is zstd
 * level 3 of that text, stored as a BLOB in the same column. A value is
 * compressed when that saves at least 5 %: tool outputs holding base64
 * screenshots in JSON came to 73 % of their size, plain tool text to 42 %.
 */
export const CODEC_TEXT = 0;
export const CODEC_ZSTD = 1;
const ZSTD_LEVEL = 3;
const ZSTD_MAX_SHARE = 0.95;
const MARK = '$blob';
// Text goes in as UTF-8 bytes cast to TEXT: bun:sqlite drops a leading U+FEFF from a string it binds.
const INSERT_BLOB = `INSERT OR REPLACE INTO part_blobs (message_id, part_index, field, thread_id, data, digest, codec, preview, chars)
  VALUES (?1, ?2, ?3, ?4, CASE ?7 WHEN ${CODEC_TEXT} THEN CAST(?5 AS TEXT) ELSE ?5 END, ?6, ?7, CAST(?8 AS TEXT), ?9)`;

type Stored = MessagePart & { [MARK]?: string[] };

const FIELDS: Partial<Record<MessagePart['type'], readonly string[]>> = {
  tool: ['output', 'inputText'],
  file: ['data'],
  image: ['data'],
};

/** The size from which `field` of a part of type `type` moves to `part_blobs`. */
function minChars(type: MessagePart['type'] | undefined, field: string): number {
  return type === 'tool' && field === 'output' ? TOOL_OUTPUT_BLOB_MIN_CHARS : BLOB_MIN_CHARS;
}

/**
 * Whether `value` of a `type` part goes to `part_blobs`: long enough, and text
 * that UTF-8 holds as it is. An unpaired surrogate would come back as U+FFFD,
 * while the row's JSON keeps it as an escape, so such a value stays inline.
 */
function movable(type: MessagePart['type'] | undefined, field: string, value: unknown): value is string {
  return typeof value === 'string' && value.length >= minChars(type, field) && (value as unknown as { isWellFormed(): boolean }).isWellFormed();
}

export function createPartBlobs(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS part_blobs (
      message_id TEXT NOT NULL, part_index INTEGER NOT NULL, field TEXT NOT NULL, thread_id TEXT NOT NULL, data TEXT NOT NULL, digest TEXT NOT NULL,
      PRIMARY KEY (message_id, part_index, field));
    CREATE INDEX IF NOT EXISTS part_blobs_thread ON part_blobs (thread_id);`);
}

/** Schema 36: the codec of `data`, the preview of a compressed tool output, the value's length. */
export function addPartBlobCodecs(db: Database): void {
  db.exec(`ALTER TABLE part_blobs ADD COLUMN codec INTEGER NOT NULL DEFAULT ${CODEC_TEXT};
    ALTER TABLE part_blobs ADD COLUMN preview TEXT;
    ALTER TABLE part_blobs ADD COLUMN chars INTEGER;`);
}

/**
 * Values compressed ahead of a write, off the main thread: the zstd bytes, or
 * null for a value that does not compress. A background pass fills it with
 * `packValues` so that its synchronous part only writes.
 */
export type Packed = Map<string, Uint8Array | null>;

/** What a value is stored as: zstd when that saves bytes, else its UTF-8 text. */
export function encodeValue(value: string, packed?: Packed): { data: Uint8Array; codec: number } {
  const ready = packed?.get(value);
  if (ready) return { data: ready, codec: CODEC_ZSTD };
  const bytes = Buffer.from(value, 'utf8');
  if (ready === null) return { data: bytes, codec: CODEC_TEXT };
  const zstd = Bun.zstdCompressSync(bytes, { level: ZSTD_LEVEL });
  return zstd.length <= bytes.length * ZSTD_MAX_SHARE ? { data: zstd, codec: CODEC_ZSTD } : { data: bytes, codec: CODEC_TEXT };
}

/** `encodeValue` for each of `values`, compressed on Bun's thread pool. */
export async function packValues(values: Iterable<string>): Promise<Packed> {
  const unique = [...new Set(values)];
  const packed = await Promise.all(unique.map(async value => {
    const bytes = Buffer.from(value, 'utf8');
    const zstd = await Bun.zstdCompress(bytes, { level: ZSTD_LEVEL });
    return zstd.length <= bytes.length * ZSTD_MAX_SHARE ? zstd : null;
  }));
  return new Map(unique.map((value, index) => [value, packed[index]!]));
}

// A value starting with U+FEFF keeps it: the default decoder drops it.
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

/** The text of a stored value. */
export function decodeValue(data: string | Uint8Array, codec: number): string {
  if (codec !== CODEC_ZSTD) return typeof data === 'string' ? data : utf8.decode(data);
  return utf8.decode(Bun.zstdDecompressSync(data as Uint8Array));
}

function writeBlob(db: Database, message: Pick<Message, 'id' | 'threadId'>, index: number, field: string, value: string, digest: string, packed?: Packed): void {
  const { data, codec } = encodeValue(value, packed);
  const preview = codec === CODEC_ZSTD && field === 'output' ? Buffer.from(value.slice(0, TOOL_OUTPUT_PREVIEW_CHARS), 'utf8') : null;
  runWrite(db, INSERT_BLOB, message.id, index, field, message.threadId, data, digest, codec, preview, value.length);
}

/**
 * The JSON stored for part `index`, after writing its large values to
 * `part_blobs`. Earlier values of that part that are gone or changed are
 * deleted, so a value that shrank leaves nothing behind; a value whose digest
 * matches the stored one is left as it is, not deleted and written again.
 */
export function storePart(db: Database, message: Pick<Message, 'id' | 'threadId'>, index: number, part: MessagePart | undefined, packed?: Packed): string {
  const fields = part === undefined || part === null ? [] : FIELDS[part.type] ?? [];
  const values = (part ?? {}) as unknown as Record<string, unknown>;
  const moved = fields.filter(field => movable(part?.type, field, values[field]));
  if (moved.length === 0) {
    db.query('DELETE FROM part_blobs WHERE message_id = ? AND part_index = ?').run(message.id, index);
    return part === undefined || part === null ? 'null' : JSON.stringify(part);
  }
  // A value is kept only under the same digest and thread: deleting a thread must still find it.
  const kept = new Map((db.query('SELECT field, digest, thread_id AS threadId FROM part_blobs WHERE message_id = ? AND part_index = ?')
    .all(message.id, index) as { field: string; digest: string; threadId: string }[]).map(row => [row.field, `${row.threadId}:${row.digest}`]));
  const remove = db.query('DELETE FROM part_blobs WHERE message_id = ? AND part_index = ? AND field = ?');
  for (const field of kept.keys()) if (!moved.includes(field)) remove.run(message.id, index, field);
  const stored: Record<string, unknown> = { ...values, [MARK]: moved };
  for (const field of moved) {
    const value = values[field] as string;
    const digest = Bun.hash(value).toString(36);
    if (kept.get(field) !== `${message.threadId}:${digest}`) writeBlob(db, message, index, field, value, digest, packed);
    stored[field] = '';
  }
  return JSON.stringify(stored);
}

/** Every part's stored JSON, in order. */
export function storeParts(db: Database, message: Pick<Message, 'id' | 'threadId' | 'parts'>): string[] {
  // Parts past the end go; storePart replaces or keeps the values of the others.
  db.query('DELETE FROM part_blobs WHERE message_id = ? AND part_index >= ?').run(message.id, message.parts.length);
  return message.parts.map((part, index) => storePart(db, message, index, part));
}

/** True when a stored `parts` text names moved values; a plain substring test, no parse. */
export function hasBlobs(parts: string): boolean {
  return parts.includes(`"${MARK}"`);
}

interface BlobRow { partIndex: number; field: string; data: string | Uint8Array; digest: string; codec: number; cut: number }

/**
 * Puts the moved values back. With `toolPreviews`, a finished tool's output
 * past `TOOL_OUTPUT_INLINE_CHARS` comes back as the bounded preview
 * `previewToolOutputs` would make, read from its `preview` column or from the
 * start of its text, so a page never loads or decompresses the whole
 * screenshot. A shorter one comes back whole, as it would from the row.
 */
export function hydrate(db: Database, message: Message, toolPreviews = false): Message {
  if (!message.parts.some(part => part !== null && typeof part === 'object' && MARK in part)) return message;
  const full = db.query('SELECT part_index AS partIndex, field, data, digest, codec, 0 AS cut FROM part_blobs WHERE message_id = ?');
  // `chars` is null on rows from before schema 37, all of them past the inline size.
  const preview = db.query(`SELECT part_index AS partIndex, field, digest,
      CASE WHEN field = 'output' AND (chars IS NULL OR chars > ${TOOL_OUTPUT_INLINE_CHARS}) THEN 1 ELSE 0 END AS cut,
      CASE WHEN field = 'output' AND (chars IS NULL OR chars > ${TOOL_OUTPUT_INLINE_CHARS})
        THEN (CASE codec WHEN ${CODEC_ZSTD} THEN preview ELSE substr(data, 1, ${TOOL_OUTPUT_PREVIEW_CHARS}) END) ELSE data END AS data,
      CASE WHEN field = 'output' AND (chars IS NULL OR chars > ${TOOL_OUTPUT_INLINE_CHARS}) THEN ${CODEC_TEXT} ELSE codec END AS codec
    FROM part_blobs WHERE message_id = ?`);
  const rows = (toolPreviews ? preview : full).all(message.id) as BlobRow[];
  const values = new Map(rows.map(row => [`${row.partIndex}:${row.field}`, row]));
  const text = (row: BlobRow | undefined) => row === undefined || row.data === null ? '' : decodeValue(row.data, row.codec);
  const parts = message.parts.map((part, index) => {
    const moved = (part as Stored | null)?.[MARK];
    if (!moved) return part;
    const restored: Record<string, unknown> = { ...part };
    delete restored[MARK];
    for (const field of moved) restored[field] = text(values.get(`${index}:${field}`));
    const output = values.get(`${index}:output`);
    if (toolPreviews && part.type === 'tool' && moved.includes('output') && part.status !== 'running' && output?.cut !== 0) {
      restored.output = (restored.output as string).slice(0, TOOL_OUTPUT_PREVIEW_CHARS);
      restored.outputDeferred = true;
      previewDigests.set(restored, output?.digest ?? '');
    } else if (toolPreviews && part.type === 'tool' && moved.includes('output') && output?.cut !== 0) {
      // A running tool's page keeps its whole output, as previewToolOutputs does.
      restored.output = readValue(db, message.id, index, 'output');
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

function readValue(db: Database, messageId: string, index: number, field: string): string {
  const row = db.query('SELECT data, codec FROM part_blobs WHERE message_id = ? AND part_index = ? AND field = ?')
    .get(messageId, index, field) as { data: string | Uint8Array; codec: number } | null;
  return row === null ? '' : decodeValue(row.data, row.codec);
}

/** One stored part with its moved values back, for a reader that took it from `json_each`. */
export function hydratePart(db: Database, messageId: string, index: number, part: MessagePart): MessagePart {
  const moved = (part as Stored)[MARK];
  if (!moved) return part;
  const restored: Record<string, unknown> = { ...part };
  delete restored[MARK];
  for (const field of moved) restored[field] = readValue(db, messageId, index, field);
  return restored as MessagePart;
}

/** The moved values of `sourceId`, written again for its copy, still encoded. */
export function copyBlobs(db: Database, sourceId: string, copy: Pick<Message, 'id' | 'threadId'>): void {
  db.query(`INSERT INTO part_blobs (message_id, part_index, field, thread_id, data, digest, codec, preview, chars)
    SELECT ?, part_index, field, ?, data, digest, codec, preview, chars FROM part_blobs WHERE message_id = ?`).run(copy.id, copy.threadId, sourceId);
}

type MessageRow = { rowid: number; id: string; threadId: string; parts: string };

/** What one bounded pass did: the last rowid it looked at, null once nothing is left, -1 when an open message holds it. */
export type PassResult = number | null;

/**
 * Moves the large values of one message written before `part_blobs` existed,
 * the first one after `afterRowid` whose row is at least `BLOB_MIN_CHARS`
 * bytes. Returns its rowid, or null once none is left. A message still held
 * open is left for later and its rowid returned as -1.
 */
export async function moveInlineValues(db: Database, afterRowid: number, isOpen: (messageId: string) => boolean): Promise<PassResult> {
  const row = db.query('SELECT rowid AS rowid, id, thread_id AS threadId, parts FROM messages WHERE rowid > ? AND octet_length(parts) >= ? ORDER BY rowid LIMIT 1')
    .get(afterRowid, BLOB_MIN_CHARS) as MessageRow | null;
  if (row === null) return null;
  if (isOpen(row.id)) return -1;
  const [done] = await moveRows(db, [row], isOpen);
  // Written or opened while its values were compressed: the next tick reads it again.
  return done ? row.rowid : afterRowid;
}

/** The inline values of a stored row that the current thresholds move out. */
function inlineValues(stored: (Stored | null)[]): string[] {
  return stored.flatMap(part => part === null || part[MARK] ? [] : (FIELDS[part.type] ?? []).flatMap(field => {
    const value = (part as unknown as Record<string, unknown>)[field];
    return movable(part.type, field, value) ? [value] : [];
  }));
}

const STALE = new Error('the row changed while its values were compressed');

/**
 * Moves the inline values of `rows` out, compressing them on the thread pool
 * first. A row is written only if it still holds the message read, under the
 * same id, thread and `parts` text, and that message is not open: a write made
 * during the compression wins, and a row a deleted message left free for a
 * copy (SQLite reuses the largest rowid) is never written under the old id.
 * Returns, per row, whether it is done: moved, or nothing to move.
 */
async function moveRows(db: Database, rows: MessageRow[], isOpen: (messageId: string) => boolean): Promise<boolean[]> {
  const parsed = rows.map(row => JSON.parse(row.parts) as (Stored | null)[]);
  const values = parsed.map(inlineValues);
  if (values.every(list => list.length === 0)) return rows.map(() => true);
  const packed = await packValues(values.flat());
  let guarded: ReturnType<Database['query']> | undefined;
  return rows.map((row, at) => {
    if (values[at]!.length === 0) return true;
    // Also true once the journal closed during the compression, before anything is prepared on it.
    if (isOpen(row.id)) return false;
    guarded ??= db.query('UPDATE messages SET parts = ? WHERE rowid = ? AND id = ? AND thread_id = ? AND parts = ?');
    try {
      db.transaction(() => {
        const texts = parsed[at]!.map((part, index) => part === null || part[MARK] ? JSON.stringify(part) : storePart(db, { id: row.id, threadId: row.threadId }, index, part, packed));
        if (guarded!.run(`[${texts.join(',')}]`, row.rowid, row.id, row.threadId, row.parts).changes !== 1) throw STALE;
      })();
      return true;
    } catch (error) {
      if (error !== STALE) throw error;
      return false;
    }
  });
}

/**
 * Moves the inline tool outputs of `TOOL_OUTPUT_BLOB_MIN_CHARS` up to
 * `BLOB_MIN_CHARS` out of rows written before schema 37, from the first row
 * after `afterRowid`, reading about `budget` bytes of rows. A message still
 * held open stops the pass with -1, as `moveInlineValues` does.
 */
export async function moveInlineOutputs(db: Database, afterRowid: number, budget: number, isOpen: (messageId: string) => boolean): Promise<PassResult> {
  const next = db.query(`SELECT rowid AS rowid, id, thread_id AS threadId, parts FROM messages
    WHERE rowid > ? AND octet_length(parts) >= ${TOOL_OUTPUT_BLOB_MIN_CHARS} ORDER BY rowid LIMIT 1`);
  const rows: MessageRow[] = [];
  let cursor = afterRowid, read = 0, open = false;
  while (read < budget) {
    const row = next.get(cursor) as MessageRow | null;
    if (row === null) break;
    if (isOpen(row.id)) { open = true; break; }
    // A cheap test first: most rows have no tool output in that range.
    if (row.parts.includes('"output":"')) rows.push(row);
    read += row.parts.length;
    cursor = row.rowid;
  }
  if (read === 0) return open ? -1 : null;
  const done = await moveRows(db, rows, isOpen);
  // The cursor stops before the first row that could not be written.
  const stuck = done.indexOf(false);
  return stuck === -1 ? cursor : rows[stuck]!.rowid - 1;
}

/**
 * Compresses `part_blobs` rows stored as text, from the first one after
 * `afterRowid`, about `budget` bytes of input, on the thread pool. A row that
 * changed meanwhile (another digest, or already compressed) is left alone.
 * Returns the last rowid looked at, or null once none is left.
 */
export async function recodePartBlobs(db: Database, afterRowid: number, budget: number, isClosed: () => boolean = () => false): Promise<PassResult> {
  const next = db.query(`SELECT rowid AS rowid, field, data, digest FROM part_blobs WHERE rowid > ? AND codec = ${CODEC_TEXT} ORDER BY rowid LIMIT 1`);
  const rows: { rowid: number; field: string; data: string; digest: string }[] = [];
  let cursor = afterRowid, read = 0;
  while (read < budget) {
    const row = next.get(cursor) as { rowid: number; field: string; data: string; digest: string } | null;
    if (row === null) break;
    rows.push(row);
    read += row.data.length;
    cursor = row.rowid;
  }
  if (rows.length === 0) return null;
  const packed = await packValues(rows.map(row => row.data));
  if (isClosed()) return afterRowid;
  const update = db.query(`UPDATE part_blobs SET data = ?, codec = ${CODEC_ZSTD}, preview = CAST(? AS TEXT), chars = ? WHERE rowid = ? AND codec = ${CODEC_TEXT} AND digest = ?`);
  const measure = db.query(`UPDATE part_blobs SET chars = ? WHERE rowid = ? AND codec = ${CODEC_TEXT} AND digest = ? AND chars IS NULL`);
  db.transaction(() => {
    for (const row of rows) {
      const zstd = packed.get(row.data);
      if (zstd) update.run(zstd, row.field === 'output' ? Buffer.from(row.data.slice(0, TOOL_OUTPUT_PREVIEW_CHARS), 'utf8') : null, row.data.length, row.rowid, row.digest);
      else measure.run(row.data.length, row.rowid, row.digest);
    }
  })();
  return cursor;
}
