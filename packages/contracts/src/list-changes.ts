import type { ListCursor } from './threads';

/**
 * How many distinct ids a `ChangeLog` remembers. A thread that changes again
 * takes one entry, so a turn streaming its progress fills nothing; past this
 * many different threads changed, the oldest is forgotten and a client whose
 * cursor is older than it reads the whole list.
 */
export const LIST_CHANGES_IDS = 4096;

/**
 * The ids changed during one run of a core, numbered in order: what lets
 * `threads.listChanges` answer only the rows a reconnecting client lacks.
 * Bounded by `limit` distinct ids.
 */
export class ChangeLog {
  #seq = 0;
  /** Every change at or before it may have been forgotten. */
  #floor = 0;
  /** Each id's last change, oldest first. */
  readonly #changed = new Map<string, number>();

  constructor(readonly run: string, public limit = LIST_CHANGES_IDS) {}

  note(id: string): void {
    this.#seq += 1;
    this.#changed.delete(id);
    this.#changed.set(id, this.#seq);
    for (const [oldest, seq] of this.#changed) {
      if (this.#changed.size <= this.limit) break;
      this.#changed.delete(oldest);
      this.#floor = seq;
    }
  }

  cursor(): ListCursor {
    return { run: this.run, seq: this.#seq };
  }

  /** The ids changed after `since`, or null when this log cannot tell: another run, or changes it forgot. */
  since(since: ListCursor): string[] | null {
    if (since.run !== this.run || since.seq < this.#floor || since.seq > this.#seq) return null;
    const ids: string[] = [];
    for (const [id, seq] of this.#changed) if (seq > since.seq) ids.push(id);
    return ids;
  }
}

/** What is wrong with a `since` a client sent, by field, or null. */
export function listCursorProblem(since: unknown): { field: string; expected: string } | null {
  if (typeof since !== 'object' || since === null || Array.isArray(since)) return { field: 'since', expected: 'an object { run, seq } from an earlier answer' };
  const { run, seq } = since as Record<string, unknown>;
  if (typeof run !== 'string' || run.length === 0 || run.length > 64) return { field: 'since.run', expected: 'the run id of an earlier answer' };
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return { field: 'since.seq', expected: 'a non-negative integer' };
  return null;
}
