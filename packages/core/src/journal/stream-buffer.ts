import type { Database } from 'bun:sqlite';
import type { Message, MessagePart } from '@boite/contracts';
import type { Journal } from '../journal.ts';
import { isNativeAgentPart } from './native-agent-parts.ts';
import { runWrite } from './statements.ts';
import { copyBlobs, hydratePart, storePart, storeParts } from './part-blobs.ts';

const DELTA_WINDOW_MS = 16;
/** The shortest wait before a streaming message's parts are written to its row. */
const PERSIST_MS = 500;
/** A slow write stretches the wait so that writing takes at most 1/PERSIST_SHARE of the time. */
const PERSIST_SHARE = 20;
const PERSIST_MAX_MS = 5_000;
/**
 * Between whole-row writes, a streaming message's changed parts go to
 * `streaming_parts`; its row is written whole at least this often, so a raw
 * SQL reader of `messages.parts` lags by at most this much.
 */
const ROW_WRITE_MS = 30_000;
const EMPTY_TEXT = JSON.stringify({ type: 'text', text: '' });
const UPSERT_SIDE = `INSERT INTO streaming_parts (message_id, part_index, thread_id, json) VALUES (?, ?, ?, ?)
  ON CONFLICT (message_id, part_index) DO UPDATE SET json = excluded.json`;
/** A delta whose write keeps failing is dropped after this many tries, and the loss reported. */
const DELTA_ATTEMPTS = 3;

interface PendingDelta {
  threadId: string;
  messageId: string;
  partIndex: number;
  text: string;
  attempts?: number;
}

/**
 * A message still streaming. Its parts live here and reach the row on a timer,
 * so a delta or a tool card costs a change in memory instead of a rewrite of a
 * row that holds every part of the turn.
 */
interface OpenMessage {
  message: Message;
  dirty: boolean;
  /**
   * Each part's stored JSON as last committed, to the row or to
   * `streaming_parts`, cleared when that part changes, so a write stores only
   * the parts that changed: their large values go to `part_blobs` once, not on
   * every write while one text part grows.
   */
  json: (string | undefined)[];
  /** True once `streaming_parts` holds committed parts the row lacks. */
  side: boolean;
  /** When the row was last written whole, from `Date.now()`. */
  rowAt: number;
}

/**
 * The streaming write path: text deltas coalesced for 16 ms, and the parts of
 * each message still streaming held in memory. A timer writes the parts that
 * changed to `streaming_parts`, one row per part, and the message row is
 * written whole when the message is let go, every 30 seconds while it streams,
 * and at close. A long turn's row of hundreds of KiB is no longer rewritten
 * twice a second to add a few words. Reads overlay held messages onto their
 * selected rows without writing.
 */
export class StreamBuffer {
  readonly #deltas = new Map<string, PendingDelta>();
  #deltaTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly open = new Map<string, OpenMessage>();
  #persistTimer: ReturnType<typeof setTimeout> | null = null;
  #persistDelay = PERSIST_MS;

  readonly #db: Database;
  readonly #journal: Pick<Journal, 'isClosed' | 'markNativeAgents'>;
  readonly #onError: (message: string) => void;

  constructor(
    db: Database,
    journal: Pick<Journal, 'isClosed' | 'markNativeAgents'>,
    onError: (message: string) => void,
  ) {
    this.#db = db;
    this.#journal = journal;
    this.#onError = onError;}

  appendDelta(threadId: string, messageId: string, partIndex: number, text: string): void {
    const key = `${messageId}|${partIndex}`;
    const current = this.#deltas.get(key);
    if (current) current.text += text;
    else this.#deltas.set(key, { threadId, messageId, partIndex, text });
    this.#armDeltaTimer();
  }

  flushDeltas(): void {
    if (this.#deltaTimer !== null) {
      clearTimeout(this.#deltaTimer);
      this.#deltaTimer = null;
    }
    if (this.#deltas.size === 0 || this.#journal.isClosed()) return;
    const items = [...this.#deltas.values()];
    this.#deltas.clear();
    const stored: PendingDelta[] = [];
    for (const item of items) {
      if (this.open.has(item.messageId)) this.#appendToPart(item.messageId, item.partIndex, item.text);
      else stored.push(item);
    }
    if (stored.length === 0) return;
    try {
      this.#db.transaction(() => {
        for (const item of stored) this.#appendToPart(item.messageId, item.partIndex, item.text);
      })();
    } catch (error) {
      this.#requeue(stored);
      throw error;
    }
  }

  persistMessages(): void {
    if (this.#persistTimer !== null) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = null;
    }
    if (this.#journal.isClosed()) return;
    const dirty = [...this.open.values()].filter((entry) => entry.dirty);
    if (dirty.length === 0) return;
    // Under a caller's transaction the write below is only a savepoint, which
    // that caller can still roll back: the parts are written but stay dirty,
    // and the timer writes them again on their own.
    const nested = this.#db.inTransaction;
    const started = performance.now();
    const now = Date.now();
    const written: [OpenMessage, (string | undefined)[], boolean][] = [];
    this.#db.transaction(() => {
      for (const entry of dirty) {
        if (now - entry.rowAt >= ROW_WRITE_MS) {
          written.push([entry, this.#writeRow(entry), true]);
          continue;
        }
        const json = [...entry.json];
        const { id, threadId } = entry.message;
        entry.message.parts.forEach((part, index) => {
          if (json[index] !== undefined) return;
          json[index] = storePart(this.#db, entry.message, index, part);
          runWrite(this.#db, UPSERT_SIDE, id, index, threadId, json[index]);
        });
        written.push([entry, json, false]);
      }
    })();
    if (nested) {
      this.#armPersistTimer();
      return;
    }
    // Clean only once committed: a rolled-back write stays dirty for the next try.
    for (const [entry, json, whole] of written) {
      entry.dirty = false;
      entry.json = json;
      entry.side = !whole;
      if (whole) entry.rowAt = now;
    }
    const elapsed = performance.now() - started;
    this.#persistDelay = Math.min(PERSIST_MAX_MS, Math.max(PERSIST_MS, Math.round(elapsed * PERSIST_SHARE)));
  }

  releaseTurn(turnId: string): void {
    this.flushDeltas();
    for (const [id, entry] of this.open) {
      if (entry.message.turnId !== turnId) continue;
      // Written whatever the flag says: it can be clean after a write a caller's
      // transaction rolled back, and the memory copy is dropped right after.
      this.#writeParts(entry);
      this.open.delete(id);
    }
  }

  /**
   * Stores the parts of a message whose row the caller writes whole, and
   * returns the row's `parts` text. A streaming message is held from here on;
   * any other state lets it go. Its old `streaming_parts` rows go.
   */
  track(message: Message): string {
    this.#db.query('DELETE FROM streaming_parts WHERE message_id = ?').run(message.id);
    const json = storeParts(this.#db, message);
    if (message.state === 'streaming') this.open.set(message.id, { message: { ...message, parts: [...message.parts] }, dirty: false, json, side: false, rowAt: Date.now() });
    else this.open.delete(message.id);
    return `[${json.join(',')}]`;
  }

  /**
   * Writes the whole row of every held message of these threads that is
   * behind, or of every held message without `threadIds`; they stay held.
   */
  writeRows(threadIds?: Set<string>): void {
    for (const entry of this.open.values()) {
      if (threadIds !== undefined && !threadIds.has(entry.message.threadId)) continue;
      if (entry.dirty || entry.side) this.#writeParts(entry);
    }
  }

  /** A copy of a message still streaming, or undefined once it is not held. */
  openCopy(messageId: string): Message | undefined {
    const open = this.open.get(messageId);
    if (open !== undefined) return { ...open.message, parts: [...open.message.parts] };
    return undefined;
  }

  /** True while any message is streaming. */
  hasOpen(): boolean {
    return this.open.size > 0;
  }

  /** Lets go of every held message of these threads, without writing them. */
  forgetThreads(removed: Set<string>): void {
    for (const [id, entry] of this.open) if (removed.has(entry.message.threadId)) this.open.delete(id);
  }

  clear(): void {
    this.open.clear();
  }

  setMessagePart(messageId: string, partIndex: number, part: MessagePart): void {
    const open = this.open.get(messageId);
    if (open !== undefined) {
      // A provider that sends the same part again changes nothing to write.
      const current = open.message.parts[partIndex];
      if (current !== undefined && samePart(current, part)) return;
      padInPlace(open.message.parts, partIndex);
      open.message.parts[partIndex] = part;
      open.json[partIndex] = undefined;
      if (isNativeAgentPart(part)) this.#journal.markNativeAgents(messageId, open.message.threadId);
      this.#markDirty(open);
      return;
    }
    const row = this.#db.query('SELECT thread_id AS threadId FROM messages WHERE id = ?').get(messageId) as { threadId: string } | null;
    if (row === null) return;
    if (isNativeAgentPart(part)) this.#journal.markNativeAgents(messageId, row.threadId);
    this.#rewritePart(messageId, partIndex, () => part);
  }

  setMessageState(messageId: string, state: Message['state']): void {
    const open = this.open.get(messageId);
    // Written whatever the flag says when the memory copy goes: a clean flag can
    // follow a write that a caller's transaction rolled back.
    if (open !== undefined && (open.dirty || state !== 'streaming')) this.#writeParts(open);
    if (state !== 'streaming') this.open.delete(messageId);
    this.#db.query('UPDATE messages SET state = ? WHERE id = ?').run(state, messageId);
  }

  #appendToPart(messageId: string, partIndex: number, text: string): void {
    const open = this.open.get(messageId);
    if (open !== undefined) {
      padInPlace(open.message.parts, partIndex);
      appendText(open.message.parts, partIndex, text);
      open.json[partIndex] = undefined;
      this.#markDirty(open);
      return;
    }
    this.#rewritePart(messageId, partIndex, current => {
      const parts = [current ?? { type: 'text' as const, text: '' }];
      appendText(parts, 0, text);
      return parts[0]!;
    });
  }

  /**
   * Changes one part of a stored message and writes back its row: the other
   * parts keep their stored JSON as it is, large values stay in `part_blobs`,
   * and only the changed part's values are read and written.
   */
  #rewritePart(messageId: string, partIndex: number, change: (part: MessagePart | undefined) => MessagePart): void {
    // Parts a message left in `streaming_parts` belong to its row first.
    foldStreamingParts(this.#db, messageId);
    const row = this.#db.query('SELECT thread_id AS threadId, parts FROM messages WHERE id = ?').get(messageId) as { threadId: string; parts: string } | null;
    if (row === null) return;
    const stored = JSON.parse(row.parts) as MessagePart[];
    const current = stored[partIndex] == null ? undefined : hydratePart(this.#db, messageId, partIndex, stored[partIndex]);
    const next = change(current);
    // An unchanged part leaves the row and its blobs as they are.
    if (current !== undefined && samePart(current, next)) return;
    padInPlace(stored, partIndex);
    const texts = stored.map(part => JSON.stringify(part ?? null));
    texts[partIndex] = storePart(this.#db, { id: messageId, threadId: row.threadId }, partIndex, next);
    runWrite(this.#db, 'UPDATE messages SET parts = ? WHERE id = ?', `[${texts.join(',')}]`, messageId);
  }

  /** Every part's stored JSON: the committed one when unchanged, else stored now. */
  #stored(entry: OpenMessage): string[] {
    return entry.message.parts.map((part, index) => entry.json[index] ?? storePart(this.#db, entry.message, index, part));
  }

  #markDirty(entry: OpenMessage): void {
    entry.dirty = true;
    this.#armPersistTimer();
  }

  #armPersistTimer(): void {
    if (this.#persistTimer !== null || this.#journal.isClosed()) return;
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      try {
        this.persistMessages();
      } catch (error) {
        // A quiet stream must retry too; failed writes retain their dirty parts.
        this.#onError(`journal message write: ${messageOfError(error)}`);
        if ([...this.open.values()].some((entry) => entry.dirty)) {
          this.#persistDelay = Math.min(PERSIST_MAX_MS, this.#persistDelay * 2);
          this.#armPersistTimer();
        }
      }
    }, this.#persistDelay);
    this.#persistTimer.unref?.();
  }

  /**
   * Writes the whole row and drops its `streaming_parts` rows, together: a
   * side row left beside a newer row would be folded over it at startup.
   */
  #writeRow(entry: OpenMessage): string[] {
    const parts = this.#stored(entry);
    this.#db.transaction(() => {
      runWrite(this.#db, 'UPDATE messages SET parts = ? WHERE id = ?', `[${parts.join(',')}]`, entry.message.id);
      this.#db.query('DELETE FROM streaming_parts WHERE message_id = ?').run(entry.message.id);
    })();
    return parts;
  }

  #writeParts(entry: OpenMessage): void {
    const parts = this.#writeRow(entry);
    // A write inside a caller's transaction is not committed yet: it stays dirty.
    if (!this.#db.inTransaction) {
      entry.dirty = false;
      entry.json = parts;
      entry.side = false;
      entry.rowAt = Date.now();
    }
  }

  #armDeltaTimer(): void {
    if (this.#deltaTimer !== null || this.#journal.isClosed()) return;
    this.#deltaTimer = setTimeout(() => {
      this.#deltaTimer = null;
      // No caller to throw to: an error thrown from a timer ends the whole process.
      try {
        this.flushDeltas();
      } catch (error) {
        this.#onError(`journal delta flush: ${messageOfError(error)}`);
      }
    }, DELTA_WINDOW_MS);
  }

  /**
   * Puts back the text of a failed flush, ahead of anything newer for the same
   * part. The next flush, from the next delta, event or close, tries it again.
   */
  #requeue(items: PendingDelta[]): void {
    for (const item of items) {
      const attempts = (item.attempts ?? 0) + 1;
      if (attempts >= DELTA_ATTEMPTS) {
        this.#onError(`journal dropped ${item.text.length} characters of message ${item.messageId} part ${item.partIndex} after ${attempts} failed writes`);
        continue;
      }
      const key = `${item.messageId}|${item.partIndex}`;
      const current = this.#deltas.get(key);
      if (current) {
        current.text = item.text + current.text;
        current.attempts = attempts;
      } else this.#deltas.set(key, { ...item, attempts });
    }
  }
}

/**
 * Writes the parts left in `streaming_parts` into their message rows and drops
 * them: at startup, after a crash or a kill mid-stream, so every reader sees
 * whole rows again, or for one message before its row is changed. Returns the
 * number of messages written.
 */
export function foldStreamingParts(db: Database, messageId?: string): number {
  const rows = (messageId === undefined
    ? db.query('SELECT message_id AS id, part_index AS partIndex, json FROM streaming_parts ORDER BY message_id, part_index').all()
    : db.query('SELECT message_id AS id, part_index AS partIndex, json FROM streaming_parts WHERE message_id = ? ORDER BY part_index').all(messageId)) as { id: string; partIndex: number; json: string }[];
  if (rows.length === 0) return 0;
  const byMessage = new Map<string, typeof rows>();
  for (const row of rows) byMessage.set(row.id, [...byMessage.get(row.id) ?? [], row]);
  db.transaction(() => {
    const read = db.query('SELECT parts FROM messages WHERE id = ?');
    for (const [id, parts] of byMessage) {
      // A message removed while it streamed has no row left to write.
      const row = read.get(id) as { parts: string } | null;
      if (row === null) continue;
      const texts = (JSON.parse(row.parts) as unknown[]).map(part => JSON.stringify(part ?? null));
      for (const { partIndex, json } of parts) {
        while (texts.length < partIndex) texts.push(EMPTY_TEXT);
        texts[partIndex] = json;
      }
      runWrite(db, 'UPDATE messages SET parts = ? WHERE id = ?', `[${texts.join(',')}]`, id);
    }
    if (messageId === undefined) db.exec('DELETE FROM streaming_parts');
    else db.query('DELETE FROM streaming_parts WHERE message_id = ?').run(messageId);
  })();
  return byMessage.size;
}

/** The moved values and the streamed parts of `sourceId`, written again for its copy. */
export function copyStoredParts(db: Database, sourceId: string, copy: Pick<Message, 'id' | 'threadId'>): void {
  copyBlobs(db, sourceId, copy);
  db.query('INSERT INTO streaming_parts (message_id, part_index, thread_id, json) SELECT ?, part_index, ?, json FROM streaming_parts WHERE message_id = ?')
    .run(copy.id, copy.threadId, sourceId);
}

export function messageOfError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function padInPlace(parts: MessagePart[], index: number): void {
  while (parts.length <= index) parts.push({ type: 'text', text: '' });
}

/** The string fields that carry a part's bulk: a tool's output and input, a file's or an image's data. */
const LARGE_FIELDS = ['output', 'inputText', 'data', 'text'] as const;
/** Past this many characters, the large fields are compared on their own and left out of the rest's JSON. */
const LARGE_CHARS = 4 * 1024;

/**
 * Whether two parts would store the same JSON. Stringifying both on every
 * update of an open message cost about 3 ms per 1 MiB part; the type, status
 * and lengths of the large fields tell most changes apart for nothing, the
 * large strings are compared directly, and only the small rest is stringified.
 */
export function samePart(left: MessagePart, right: MessagePart): boolean {
  if (left === right) return true;
  const a = left as unknown as Record<string, unknown>, b = right as unknown as Record<string, unknown>;
  if (a.type !== b.type || a.status !== b.status) return false;
  let large = false;
  for (const field of LARGE_FIELDS) {
    const x = a[field], y = b[field];
    if (typeof x !== 'string' || typeof y !== 'string') continue;
    if (x.length !== y.length) return false;
    if (x.length >= LARGE_CHARS) large = true;
  }
  if (!large) return JSON.stringify(left) === JSON.stringify(right);
  const rest = (value: Record<string, unknown>) => {
    const copy: Record<string, unknown> = { ...value };
    for (const field of LARGE_FIELDS) if (typeof copy[field] === 'string' && (copy[field] as string).length >= LARGE_CHARS) copy[field] = true;
    return JSON.stringify(copy);
  };
  if (rest(a) !== rest(b)) return false;
  // Equal lengths, both large: a direct comparison stops at the first difference.
  return LARGE_FIELDS.every(field => typeof a[field] !== 'string' || (a[field] as string).length < LARGE_CHARS || a[field] === b[field]);
}

/** A delta appends to whatever kind of text part sits there: text or thinking. */
function appendText(parts: MessagePart[], index: number, text: string): void {
  const part = parts[index];
  if (part !== undefined && (part.type === 'text' || part.type === 'thinking')) {
    parts[index] = { ...part, text: part.text + text };
  } else if (part !== undefined && part.type === 'tool') {
    // On a tool part a delta is the input's JSON, still being typed by the model.
    parts[index] = { ...part, inputText: (part.inputText ?? '') + text };
  } else parts[index] = { type: 'text', text };
}
