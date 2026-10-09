/*
 * What the companion's agent was last given, so it is given again what
 * changed since: the role once per conversation and whenever it changes, the
 * memory whenever it changes (a fact the user removed in Settings, a fact the
 * agent asked to keep, or one that was lost on the way). Without it the agent
 * believes what the conversation says it noted, not what was kept. The record
 * is one entry in `localStorage`, for the conversation's thread; hashes keep
 * it small. Pure but for the storage.
 */
import type { Priming } from './brain';

export interface Primed {
  threadId: string;
  /** `hashText` of the role it was given. */
  role: string;
  /** `hashText` of the memory it last saw, as `memoryBlock` wrote it. */
  memory: string;
  /** A reply's directives could not be read: the memory goes again with the next request. */
  check: boolean;
}

export const PRIMED_KEY = 'boite.companion.primed';

/** FNV-1a, 32 bits: enough to tell one role or one memory from the next. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * What the next request to `thread` carries. `fresh` is a thread that holds
 * no request yet. A conversation the record does not know was primed with
 * some role, maybe an older one: it gets this one again.
 */
export function primingFor(primed: Primed | null, thread: { id: string; fresh: boolean }, role: string, memory: string): Priming {
  const known = primed?.threadId === thread.id ? primed : null;
  if (!known) return thread.fresh ? 'new' : 'role';
  if (known.role !== hashText(role)) return 'role';
  return known.check || known.memory !== hashText(memory) ? 'memory' : null;
}

export function parsePrimed(raw: unknown): Primed | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const text = (field: unknown) => (typeof field === 'string' && field ? field : null);
  const [threadId, role, memory] = [text(value.threadId), text(value.role), text(value.memory)];
  return threadId && role && memory ? { threadId, role, memory, check: value.check === true } : null;
}

export function readPrimed(): Primed | null {
  try {
    return parsePrimed(JSON.parse(window.localStorage.getItem(PRIMED_KEY) ?? 'null'));
  } catch {
    return null;
  }
}

export function writePrimed(primed: Primed): void {
  try {
    window.localStorage.setItem(PRIMED_KEY, JSON.stringify(primed));
  } catch {
    /* refused: the next request carries the role again */
  }
}

/** The reply's directives were lost: its thread gets the memory again. */
export function doubtPrimed(threadId: string): void {
  const primed = readPrimed();
  if (primed?.threadId === threadId) writePrimed({ ...primed, check: true });
}

/** The thread moved to another agent, which starts a session of its own: it gets the role again. */
export function forgetPrimed(): void {
  try {
    window.localStorage.removeItem(PRIMED_KEY);
  } catch {
    /* nothing kept */
  }
}
