import type { Database } from 'bun:sqlite';
import type { Message, MessagePart } from '@boite/contracts';
import type { Journal } from '../journal.ts';

const DELTA_WINDOW_MS = 16;
/** The shortest wait before a streaming message's parts are written to its row. */
const PERSIST_MS = 500;
/** A slow write stretches the wait so that writing takes at most 1/PERSIST_SHARE of the time. */
const PERSIST_SHARE = 20;
const PERSIST_MAX_MS = 5_000;
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
}

/**
 * The streaming write path: text deltas coalesced for 16 ms, and the parts of
 * each message still streaming held in memory and written to its row on a
 * timer. The journal calls it before every read of messages.
 */
export class StreamBuffer {
  private readonly deltas = new Map<string, PendingDelta>();
  private deltaTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly open = new Map<string, OpenMessage>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistDelay = PERSIST_MS;

  constructor(
    private readonly db: Database,
    private readonly journal: Pick<Journal, 'getMessage' | 'isClosed'>,
    private readonly onError: (message: string) => void,
  ) {}

  appendDelta(threadId: string, messageId: string, partIndex: number, text: string): void {
    const key = `${messageId}|${partIndex}`;
    const current = this.deltas.get(key);
    if (current) current.text += text;
    else this.deltas.set(key, { threadId, messageId, partIndex, text });
    this.armDeltaTimer();
  }

  /**
   * Applies the buffered text. Streamed text is no event of its own: it is
   * journaled as the message it lands in, between the `message.started`,
   * `message.part` and `message.completed` events that frame it.
   */
  flushDeltas(): void {
    if (this.deltaTimer !== null) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = null;
    }
    if (this.deltas.size === 0 || this.journal.isClosed()) return;
    const items = [...this.deltas.values()];
    this.deltas.clear();
    const stored: PendingDelta[] = [];
    for (const item of items) {
      if (this.open.has(item.messageId)) this.appendToPart(item.messageId, item.partIndex, item.text);
      else stored.push(item);
    }
    if (stored.length === 0) return;
    try {
      this.db.transaction(() => {
        for (const item of stored) this.appendToPart(item.messageId, item.partIndex, item.text);
      })();
    } catch (error) {
      this.requeue(stored);
      throw error;
    }
  }

  /** Writes the parts of every streaming message whose row is behind. */
  persistMessages(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.journal.isClosed()) return;
    const dirty = [...this.open.values()].filter((entry) => entry.dirty);
    if (dirty.length === 0) return;
    // Under a caller's transaction the write below is only a savepoint, which
    // that caller can still roll back: the parts are written but stay dirty,
    // and the timer writes them again on their own.
    const nested = this.db.inTransaction;
    const started = performance.now();
    const write = this.db.query('UPDATE messages SET parts = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const entry of dirty) write.run(JSON.stringify(entry.message.parts), entry.message.id);
    })();
    if (nested) {
      this.armPersistTimer();
      return;
    }
    // Clean only once committed: a rolled-back write stays dirty for the next try.
    for (const entry of dirty) entry.dirty = false;
    const elapsed = performance.now() - started;
    this.persistDelay = Math.min(PERSIST_MAX_MS, Math.max(PERSIST_MS, Math.round(elapsed * PERSIST_SHARE)));
  }

  /**
   * The turn is over: whatever message its driver left open is written and no
   * longer held in memory. Its state stays what the driver left.
   */
  releaseTurn(turnId: string): void {
    this.flushDeltas();
    for (const [id, entry] of this.open) {
      if (entry.message.turnId !== turnId) continue;
      // Written whatever the flag says: it can be clean after a write a caller's
      // transaction rolled back, and the memory copy is dropped right after.
      this.writeParts(entry);
      this.open.delete(id);
    }
  }

  /** A streaming message is held from here on; any other state lets it go. */
  track(message: Message): void {
    if (message.state === 'streaming') this.open.set(message.id, { message: { ...message, parts: [...message.parts] }, dirty: false });
    else this.open.delete(message.id);
  }

  /** A copy of a message still streaming, or undefined once it is not held. */
  openCopy(messageId: string): Message | undefined {
    const open = this.open.get(messageId);
    if (open !== undefined) return { ...open.message, parts: [...open.message.parts] };
    return undefined;
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
      padInPlace(open.message.parts, partIndex);
      open.message.parts[partIndex] = part;
      this.markDirty(open);
      return;
    }
    const message = this.journal.getMessage(messageId);
    if (message === null) return;
    const parts = padParts(message.parts, partIndex);
    parts[partIndex] = part;
    this.db.query('UPDATE messages SET parts = ? WHERE id = ?').run(JSON.stringify(parts), messageId);
  }

  setMessageState(messageId: string, state: Message['state']): void {
    const open = this.open.get(messageId);
    // Written whatever the flag says when the memory copy goes: a clean flag can
    // follow a write that a caller's transaction rolled back.
    if (open !== undefined && (open.dirty || state !== 'streaming')) this.writeParts(open);
    if (state !== 'streaming') this.open.delete(messageId);
    this.db.query('UPDATE messages SET state = ? WHERE id = ?').run(state, messageId);
  }

  private appendToPart(messageId: string, partIndex: number, text: string): void {
    const open = this.open.get(messageId);
    if (open !== undefined) {
      padInPlace(open.message.parts, partIndex);
      appendText(open.message.parts, partIndex, text);
      this.markDirty(open);
      return;
    }
    const message = this.journal.getMessage(messageId);
    if (message === null) return;
    const parts = padParts(message.parts, partIndex);
    appendText(parts, partIndex, text);
    this.db.query('UPDATE messages SET parts = ? WHERE id = ?').run(JSON.stringify(parts), messageId);
  }

  private markDirty(entry: OpenMessage): void {
    entry.dirty = true;
    this.armPersistTimer();
  }

  private armPersistTimer(): void {
    if (this.persistTimer !== null || this.journal.isClosed()) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        this.persistMessages();
      } catch (error) {
        // The parts stay dirty in memory: the next change or read writes them again.
        this.onError(`journal message write: ${messageOfError(error)}`);
      }
    }, this.persistDelay);
    this.persistTimer.unref?.();
  }

  private writeParts(entry: OpenMessage): void {
    this.db.query('UPDATE messages SET parts = ? WHERE id = ?').run(JSON.stringify(entry.message.parts), entry.message.id);
    // A write inside a caller's transaction is not committed yet: it stays dirty.
    if (!this.db.inTransaction) entry.dirty = false;
  }

  private armDeltaTimer(): void {
    if (this.deltaTimer !== null || this.journal.isClosed()) return;
    this.deltaTimer = setTimeout(() => {
      this.deltaTimer = null;
      // No caller to throw to: an error thrown from a timer ends the whole process.
      try {
        this.flushDeltas();
      } catch (error) {
        this.onError(`journal delta flush: ${messageOfError(error)}`);
      }
    }, DELTA_WINDOW_MS);
  }

  /**
   * Puts back the text of a failed flush, ahead of anything newer for the same
   * part. The next flush, from the next delta, event or close, tries it again.
   */
  private requeue(items: PendingDelta[]): void {
    for (const item of items) {
      const attempts = (item.attempts ?? 0) + 1;
      if (attempts >= DELTA_ATTEMPTS) {
        this.onError(`journal dropped ${item.text.length} characters of message ${item.messageId} part ${item.partIndex} after ${attempts} failed writes`);
        continue;
      }
      const key = `${item.messageId}|${item.partIndex}`;
      const current = this.deltas.get(key);
      if (current) {
        current.text = item.text + current.text;
        current.attempts = attempts;
      } else this.deltas.set(key, { ...item, attempts });
    }
  }
}

export function messageOfError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function padParts(parts: MessagePart[], index: number): MessagePart[] {
  const out = [...parts];
  padInPlace(out, index);
  return out;
}

function padInPlace(parts: MessagePart[], index: number): void {
  while (parts.length <= index) parts.push({ type: 'text', text: '' });
}

/** A delta appends to whatever kind of text part sits there: text or thinking. */
function appendText(parts: MessagePart[], index: number, text: string): void {
  const part = parts[index];
  if (part !== undefined && (part.type === 'text' || part.type === 'thinking')) {
    parts[index] = { type: part.type, text: part.text + text };
  } else if (part !== undefined && part.type === 'tool') {
    // On a tool part a delta is the input's JSON, still being typed by the model.
    parts[index] = { ...part, inputText: (part.inputText ?? '') + text };
  } else parts[index] = { type: 'text', text };
}
