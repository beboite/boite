import type { ProjectId, Thread, ThreadSummary } from '@boite/contracts';

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
export function patchRow(row: ThreadSummary, next: ThreadSummary): void {
  const target = row as unknown as Record<string, unknown>;
  const source = next as unknown as Record<string, unknown>;
  for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
  for (const [key, value] of Object.entries(source)) if (!same(target[key], value)) target[key] = value;
}

/** The live top-level threads of each project, in one pass over the rows. */
export function threadsByProject(threads: readonly ThreadSummary[]): Map<ProjectId, ThreadSummary[]> {
  const groups = new Map<ProjectId, ThreadSummary[]>();
  for (const thread of threads) {
    if (thread.archived || thread.parentThreadId || thread.projectId === null) continue;
    const group = groups.get(thread.projectId);
    if (group) group.push(thread);
    else groups.set(thread.projectId, [thread]);
  }
  return groups;
}

/**
 * A `threads.get` answer that starts at `messagesFrom`, laid over the window
 * already held: what came before that message stays, the rest is the core's.
 */
export function mergeResumed(held: Thread, fetched: Thread): void {
  if (fetched.messagesFrom === undefined) return;
  const fresh = new Set(fetched.messages.map((message) => message.id));
  const from = held.messages.findIndex((message) => message.id === fetched.messagesFrom);
  const kept = held.messages.slice(0, from === -1 ? held.messages.length : from).filter((message) => !fresh.has(message.id));
  fetched.messages = [...kept, ...fetched.messages];
  const freshTurns = new Set(fetched.turns.map((turn) => turn.id));
  fetched.turns = [...held.turns.filter((turn) => !freshTurns.has(turn.id)), ...fetched.turns];
  fetched.messagesBefore = held.messagesBefore;
  delete fetched.messagesFrom;
}
