import type { AgentLetter, Thread, ThreadId } from '@boite/contracts';
import type { FakeContext } from './context';

/*
 * As the core's letter scopes: a thread holds through its own contact mail
 * sent outside a shared project and through the conversations it continues.
 * Trusting clears the mail of that history; every descendant takes its hold
 * as it now stands, its own mail kept.
 */
const mail = new WeakMap<FakeContext, Map<ThreadId, string[]>>();
// The shared-compute fake names its remote job threads, where a history stops.
const workers = new WeakMap<FakeContext, (threadId: ThreadId) => boolean>();

export function holdBoundary(ctx: FakeContext, isWorker: (threadId: ThreadId) => boolean): void {
  workers.set(ctx, isWorker);
}

function sharedWorker(ctx: FakeContext, threadId: ThreadId): boolean {
  return workers.get(ctx)?.(threadId) ?? false;
}

function heldMail(ctx: FakeContext): Map<ThreadId, string[]> {
  let held = mail.get(ctx);
  if (!held) { held = new Map(); mail.set(ctx, held); }
  return held;
}

function history(ctx: FakeContext, threadId: ThreadId): ThreadId[] {
  const ids: ThreadId[] = [];
  for (let thread = ctx.threads.get(threadId); thread && !ids.includes(thread.id); thread = thread.parentThreadId ? ctx.threads.get(thread.parentThreadId) : undefined) {
    ids.push(thread.id);
    if (sharedWorker(ctx, thread.id)) break;
  }
  return ids;
}

function holdOf(ctx: FakeContext, threadId: ThreadId): Thread['contactHold'] {
  const contacts = [...new Set(history(ctx, threadId).flatMap(id => heldMail(ctx).get(id) ?? []))];
  return contacts.length ? { contacts } : null;
}

/** The threads and their descendants take their hold, and those whose hold changed are announced. */
function settle(ctx: FakeContext, changed: ThreadId[]): void {
  const seen = new Set<ThreadId>();
  const queue = [...changed];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const thread = ctx.threads.get(id);
    if (!thread) continue;
    const hold = holdOf(ctx, id);
    if (JSON.stringify(thread.contactHold ?? null) !== JSON.stringify(hold)) { thread.contactHold = hold; ctx.touch(thread); }
    for (const child of ctx.threads.values()) if (child.parentThreadId === id && !sharedWorker(ctx, child.id)) queue.push(child.id);
  }
}

/** Mail from these contacts, outside a shared project, reached the thread; earlier holders stay. */
export function holdContactMail(ctx: FakeContext, threadId: ThreadId, contacts: string[]): void {
  heldMail(ctx).set(threadId, [...new Set([...(heldMail(ctx).get(threadId) ?? []), ...contacts])]);
  settle(ctx, [threadId]);
}

export function trustContactMail(ctx: FakeContext, threadId: ThreadId): void {
  const ids = history(ctx, threadId);
  for (const id of ids) heldMail(ctx).delete(id);
  settle(ctx, ids);
}

/** Letters the owner delivered one by one, as the core's approval digests. */
const approved = new WeakMap<FakeContext, Set<string>>();

/**
 * As the core's `contactMailGate`: contact mail outside a shared project
 * reaches the agent when its contact is trusted or the owner delivered it.
 * Other mail waits for the owner, except on a tool-free thread (echo in
 * default mode), which reads it and takes the hold.
 */
export function contactMailRoute(ctx: FakeContext, threadId: ThreadId, letter: AgentLetter, trusted: boolean): 'open' | 'cleared' | 'owner' | 'tool-free' {
  if (!letter.contact || letter.sharedProjectId) return 'open';
  if (trusted || approved.get(ctx)?.has(letter.id)) return 'cleared';
  const thread = ctx.threads.get(threadId);
  const provider = thread && ctx.providers.find(entry => entry.id === thread.providerId);
  return provider?.protocol === 'echo' && thread!.permissionMode === 'default' ? 'tool-free' : 'owner';
}

export function approveContactMail(ctx: FakeContext, letterId: string): void {
  let ids = approved.get(ctx);
  if (!ids) { ids = new Set(); approved.set(ctx, ids); }
  ids.add(letterId);
}
