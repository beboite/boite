import type { MessageId, RpcParams, Thread } from './index';

/** The earliest unfinished message, otherwise the last message already held. */
export function resumeAnchor(thread: Pick<Thread, 'messages' | 'turns'>): MessageId | null {
  const finished = new Set(thread.turns.filter(turn => turn.finishedAt !== null).map(turn => turn.id));
  const open = thread.messages.find(message => message.state === 'streaming' || !finished.has(message.turnId));
  return (open ?? thread.messages.at(-1))?.id ?? null;
}

/** New snapshot options are shared by the real router and the in-memory transport. */
export function snapshotOptionsProblem(options: Pick<RpcParams<'threads.get'>, 'sync' | 'open'>): { field: string; expected: string } | null {
  const bad = (field: string, expected: string) => ({ field, expected });
  if (options.sync !== undefined && options.sync !== true) {
    const sync = options.sync;
    if (!sync || typeof sync !== 'object' || Array.isArray(sync)) return bad('sync', 'true or a resume proof');
    if (typeof sync.from !== 'string' || !sync.from.length) return bad('sync.from', 'a nonempty message id');
    if (typeof sync.hash !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(sync.hash)) return bad('sync.hash', '16 to 128 URL-safe characters');
  }
  if (options.open !== undefined) {
    const open = options.open;
    if (!open || typeof open !== 'object' || Array.isArray(open)) return bad('open', 'opening options');
    if (open.previous !== undefined && (typeof open.previous !== 'string' || !open.previous.length)) return bad('open.previous', 'a nonempty thread id');
    for (const field of ['requests', 'markRead'] as const) if (open[field] !== undefined && typeof open[field] !== 'boolean') return bad(`open.${field}`, 'a boolean');
  }
  return null;
}
