import type { MessageId, ProjectId, Thread, ThreadId, ThreadLoad, ThreadSummary } from '@boite/contracts';
import { resumeAnchor, threadBusy } from '@boite/contracts';
import { needsUser } from './thread-state';
export { resumeAnchor } from '@boite/contracts';

/**
 * A parent's delegated agents still at work, a turn under way or a wait on
 * their own background work, and when the first of them started (null before
 * any has); `asking`, those waiting on the user, busy or not.
 */
export type WorkingChildren = { count: number; since: number | null; asking: number };

/** Each parent with a working or asking child, shared by every row of this machine. */
export function workingChildren(threads: readonly ThreadSummary[]): Map<ThreadId, WorkingChildren> {
  const parents = new Map<ThreadId, WorkingChildren>();
  for (const thread of threads) {
    const parent = thread.parentThreadId;
    if (!parent || thread.archived) continue;
    const busy = threadBusy(thread), asks = needsUser(thread);
    if (!busy && !asks) continue;
    const held = parents.get(parent) ?? { count: 0, since: null, asking: 0 };
    const wait = thread.backgroundWait;
    const started = busy ? thread.runningSince ?? (wait?.state === 'waiting' ? wait.since : null) : null;
    parents.set(parent, {
      count: held.count + (busy ? 1 : 0),
      since: started === null ? held.since : held.since === null ? started : Math.min(held.since, started),
      asking: held.asking + (asks ? 1 : 0)
    });
  }
  return parents;
}

/** Same value: primitives by identity, the small objects of a summary (load, context, cache) by content. */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Writes onto a held sidebar row only the fields that changed. The rows live in
 * a deep `$state` array, so a load tick then signals `row.load` alone: the
 * project lists, which read ids, projects and flags, do not run again.
 */
/** A `thread.load` on one held copy of the row: written only when it moved, so an unchanged sample re-renders nothing. */
export function patchLoad(row: Pick<ThreadSummary, 'load'>, load: ThreadLoad): void {
  if (!same(row.load, load)) row.load = load;
}

export function patchRow(row: ThreadSummary, next: ThreadSummary): void {
  const target = row as unknown as Record<string, unknown>;
  for (const key of Object.keys(target)) if (!(key in next)) delete target[key];
  patchFields(row, next);
}

/**
 * `Object.assign` of a summary over a held thread, without the writes that
 * change nothing. The open thread is a deep `$state` proxy: assigning a load
 * tick whole gave `load`, the usage and the context new proxies each second,
 * and every reaction reading them ran again. Nothing is deleted, since a
 * thread holds messages, turns and pages a summary does not carry.
 */
export function patchFields<T extends object>(held: T, next: Partial<T>): void {
  const target = held as Record<string, unknown>;
  for (const [key, value] of Object.entries(next)) if (!same(target[key], value)) target[key] = value;
}

/**
 * A fresh `threads.list` over the rows already held: a row the list still has
 * keeps its identity, patched, so a reconnect re-renders only the rows that
 * changed. The list's order wins and a row it no longer has is gone.
 */
export function reconcileRows(held: readonly ThreadSummary[], fresh: ThreadSummary[]): ThreadSummary[] {
  const byId = new Map(held.map((row) => [row.id, row]));
  return fresh.map((next) => {
    const row = byId.get(next.id);
    if (!row) return next;
    patchRow(row, next);
    return row;
  });
}

/** Project conversations include work delegated by a bot; ordinary helpers stay under their parent. */
export function projectThread(thread: ThreadSummary, parent?: ThreadSummary): boolean {
  return thread.projectId !== null && !thread.agentSessionId && (!thread.parentThreadId || thread.parentIsBot === true || !!parent?.agentSessionId);
}

/** The live project conversations, indexed once per change of the rows. */
export function threadsByProject(threads: readonly ThreadSummary[]): Map<ProjectId, ThreadSummary[]> {
  const groups = new Map<ProjectId, ThreadSummary[]>();
  const bots = new Map(threads.filter(thread => thread.agentSessionId).map(thread => [thread.id, thread]));
  for (const thread of threads) {
    // An incognito conversation stays off the lists: it lives on its own screen only.
    if (thread.archived || thread.incognito || !projectThread(thread, bots.get(thread.parentThreadId ?? ''))) continue;
    const group = groups.get(thread.projectId!);
    if (group) group.push(thread);
    else groups.set(thread.projectId!, [thread]);
  }
  return groups;
}

/**
 * The index of the item with that id, searched from the end. What a stream
 * writes to is the newest message or turn, so this stops at once where a
 * forward `find` crossed the whole loaded timeline on every delta.
 */
export function lastIndexById<T extends { id: string }>(items: readonly T[], id: string): number {
  for (let index = items.length - 1; index >= 0; index--) if (items[index]!.id === id) return index;
  return -1;
}

/** The `threads.get` parameters for a thread, from its resume anchor when part of it is held. */
export function resumeRequest(threadId: ThreadId, held: Pick<Thread, 'messages' | 'turns'> | undefined): { threadId: ThreadId; after?: MessageId } {
  const after = held ? resumeAnchor(held) : null;
  return after === null ? { threadId } : { threadId, after };
}

/** A panel key of the machine `machineId`: prefixed with its id, or bare on a store that has none. */
export function ownsPanelKey(machineId: string, key: string): boolean {
  if (!machineId) return !key.startsWith('[');
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && parsed[0] === machineId;
  } catch {
    return false;
  }
}

/**
 * The layouts a fresh `threads.list` leaves behind: this machine's, of threads
 * it no longer lists. The thread on screen is never one of them: archived from
 * another client, it stays open here, and goes when this client leaves it.
 */
export function unlistedPanels(machineId: string, listed: ReadonlySet<string>, openKey: string | null): (key: string) => boolean {
  return (key) => key !== openKey && !listed.has(key) && ownsPanelKey(machineId, key);
}

/**
 * A `threads.get` answer that starts at `messagesFrom`, laid over the window
 * already held: what came before that message stays, the rest is the core's.
 */
export function mergeResumed(held: Thread, fetched: Thread): void {
  if (fetched.messagesFrom === undefined) return;
  if (fetched.messagesUnchanged) fetched.messages = held.messages;
  else {
    const fresh = new Set(fetched.messages.map((message) => message.id));
    const from = held.messages.findIndex((message) => message.id === fetched.messagesFrom);
    const kept = held.messages.slice(0, from === -1 ? held.messages.length : from).filter((message) => !fresh.has(message.id));
    fetched.messages = [...kept, ...fetched.messages];
  }
  const freshTurns = new Set(fetched.turns.map((turn) => turn.id));
  fetched.turns = [...held.turns.filter((turn) => !freshTurns.has(turn.id)), ...fetched.turns];
  fetched.messagesBefore = held.messagesBefore;
  delete fetched.messagesFrom;
  delete fetched.messagesUnchanged;
}

/** JSON wire values compared without allocating another copy of a large tool payload. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a), right = Object.keys(b);
  if (left.length !== right.length) return false;
  return left.every(key => Object.hasOwn(b, key) && sameValue(Reflect.get(a, key), Reflect.get(b, key)));
}

/** Keep unchanged messages and turns; a preview cannot certify a previously loaded suffix. */
export function reconcileThread(held: Thread, fresh: Thread): Thread {
  const messages = new Map(held.messages.map(message => [message.id, message]));
  fresh.messages = fresh.messages.map(message => {
    const previous = messages.get(message.id);
    if (!previous) return message;
    if (previous === message) return previous;
    return sameValue(previous, message) ? previous : message;
  });
  const turns = new Map(held.turns.map(turn => [turn.id, turn]));
  fresh.turns = fresh.turns.map(turn => sameValue(turns.get(turn.id), turn) ? turns.get(turn.id)! : turn);
  if (fresh.messages.length === held.messages.length && fresh.messages.every((message, index) => message === held.messages[index])) fresh.messages = held.messages;
  if (fresh.turns.length === held.turns.length && fresh.turns.every((turn, index) => turn === held.turns[index])) fresh.turns = held.turns;
  Object.assign(held, fresh);
  return held;
}
