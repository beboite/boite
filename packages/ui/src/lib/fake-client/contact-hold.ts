import type { Thread, ThreadId } from '@boite/contracts';
import type { FakeContext } from './context';

/*
 * As the core's letter scopes: a thread holds through its own contact mail
 * sent outside a shared project and through the conversations it continues.
 * Trusting clears the mail of that history; every descendant takes its hold
 * as it now stands, its own mail kept.
 */
const mail = new WeakMap<FakeContext, Map<ThreadId, string[]>>();

function heldMail(ctx: FakeContext): Map<ThreadId, string[]> {
  let held = mail.get(ctx);
  if (!held) { held = new Map(); mail.set(ctx, held); }
  return held;
}

function history(ctx: FakeContext, threadId: ThreadId): ThreadId[] {
  const ids: ThreadId[] = [];
  for (let thread = ctx.threads.get(threadId); thread && !ids.includes(thread.id); thread = thread.parentThreadId ? ctx.threads.get(thread.parentThreadId) : undefined) ids.push(thread.id);
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
    for (const child of ctx.threads.values()) if (child.parentThreadId === id) queue.push(child.id);
  }
}

export function holdContactMail(ctx: FakeContext, threadId: ThreadId, contacts: string[]): void {
  heldMail(ctx).set(threadId, contacts);
  settle(ctx, [threadId]);
}

export function trustContactMail(ctx: FakeContext, threadId: ThreadId): void {
  const ids = history(ctx, threadId);
  for (const id of ids) heldMail(ctx).delete(id);
  settle(ctx, ids);
}
