import { createHash } from 'node:crypto';
import { MESSAGE_PAGE, MESSAGE_PAGE_MAX, MESSAGE_PAGE_MAX_BYTES, boundedMessageWindow, resumeAnchor, snapshotOptionsProblem } from '@boite/contracts';
import type { Message, RpcParams, Thread, ThreadSummary, Turn } from '@boite/contracts';
import type { Core } from '../core';
import { invalidParams, refused } from '../errors';
import type { AgentState } from './agent-state';
import { readMemoryEvents } from './memory-read';
import { previewDigests } from '../journal/part-blobs';
import { transportProjection } from './transport';

type Projection = ReturnType<typeof transportProjection>;
type Options = Pick<RpcParams<'threads.get'>, 'limit' | 'compactTools' | 'compactFiles' | 'compactImages' | 'compactToolParts' | 'around' | 'sync' | 'open'>;
// A preview read from part_blobs hashes the digest of its whole output, which the page does not carry.
const withDigests = (_key: string, value: unknown) => {
  const digest = value !== null && typeof value === 'object' ? previewDigests.get(value) : undefined;
  return digest === undefined ? value : { ...value as object, outputDigest: digest };
};
/** Over the rows as read, deferred content included: the same rows read with other options are another proof. */
const hash = (messages: Message[], options: Options) => createHash('sha256').update(`${!!options.compactTools}:${!!options.compactFiles}:${!!options.compactImages}:${!!options.compactToolParts}:`).update(JSON.stringify(messages, withDigests)).digest('base64url');
/** Outputs a page defers are read as previews from part_blobs, never whole. */
const toolPreviews = (options: { compactTools?: boolean; compactToolParts?: boolean }) => !!(options.compactTools || options.compactToolParts);

/** Validate new options before an opening can change the socket or unread state. */
export function checkSnapshotOptions(options: Options): void {
  const problem = snapshotOptionsProblem(options);
  if (problem) throw invalidParams(`threads.get.${problem.field}: expected ${problem.expected}`, problem);
}

/** A full resume tail or a bounded page. Proofs include the unseen suffix of tool previews. */
export function threadSnapshot(core: Core, thread: ThreadSummary, after: string | undefined, options: Options, state: AgentState): Thread {
  checkSnapshotOptions(options);
  const asked = options.limit ?? MESSAGE_PAGE;
  if (!Number.isFinite(asked)) throw refused('threads.get limit must be a finite number', { limit: options.limit });
  const limit = Math.min(Math.max(1, Math.trunc(asked)), MESSAGE_PAGE_MAX);
  // The snapshot contains buffered text; later events contain only subsequent text.
  core.journal.flushDeltas();
  core.bus.flush();
  const from = after === undefined ? null : core.journal.messageRowid(thread.id, after);
  // Budgets apply to what the client receives, so compacted parts never block
  // a page. The proof covers the stored rows, deferred content included.
  const project = transportProjection(options, options.compactImages ? core.media.lookup(thread.id) : undefined);
  const tail = from === null ? null : core.journal.listMessagesFrom(thread.id, from, limit, project, toolPreviews(options));
  const page = tail === null ? pageAround(core, thread.id, options.around, limit, project, toolPreviews(options)) : { ...tail, before: null, after: null };
  const turns = core.journal.listTurnsFor(thread.id, page.messages.map(message => message.turnId));
  const anchor = options.sync ? resumeAnchor({ messages: page.messages, turns }) : null;
  const anchorIndex = anchor === null ? -1 : page.messages.findIndex(message => message.id === anchor);
  const proof = anchor === null ? undefined : { from: anchor, hash: hash(page.messages.slice(anchorIndex), options) };
  const known = options.sync && options.sync !== true ? options.sync : undefined;
  const unchanged = tail !== null && after !== undefined && known?.from === after &&
    known.hash === (proof?.from === after ? proof.hash : hash(tail.messages, options));
  return {
    ...thread,
    ...(tail === null || after === undefined ? {} : { messagesFrom: after }),
    ...(proof ? { messagesSync: proof } : {}),
    ...(unchanged ? { messagesUnchanged: true as const } : {}),
    messages: unchanged ? [] : page.sent,
    memoryEvents: readMemoryEvents(core.journal, thread.id),
    commands: state.commands.get(thread.id) ?? [],
    background: state.background.get(thread.id) ?? [],
    backgroundHistory: state.backgroundHistory.list(thread.id),
    activity: core.activity.get(thread.id),
    messagesBefore: page.before,
    ...(page.after === null ? {} : { messagesAfter: page.after }),
    turns,
  };
}

/**
 * The last page, unless `around` names a message with more than `limit`
 * written after it: then half a page before it and half from it on. A count
 * on the index decides, so the far case reads no row it does not send.
 * Both halves share MESSAGE_PAGE_MAX_BYTES and the requested count; cuts
 * retain the anchor and rewrite cursors to the retained edges.
 */
function pageAround(core: Core, threadId: string, around: string | undefined, limit: number, project: Projection, toolPreviews: boolean): { messages: Message[]; sent: Message[]; before: string | null; after: string | null } {
  const journal = core.journal;
  const rowid = around === undefined ? null : journal.messageRowid(threadId, around);
  if (rowid === null || journal.countMessagesFrom(threadId, rowid) <= limit) return { ...journal.listMessagePage(threadId, { limit, project, toolPreviews }), after: null };
  const half = Math.max(1, Math.floor(limit / 2));
  const older = journal.listMessagePage(threadId, { beforeRowid: rowid, limit: half, project, toolPreviews });
  const newer = journal.listMessagesForward(threadId, rowid, Math.max(1, limit - half), project, toolPreviews);
  const messages = [...older.messages, ...newer.messages], sent = [...older.sent, ...newer.sent];
  const { start, end } = boundedMessageWindow(sent, older.messages.length, MESSAGE_PAGE_MAX_BYTES, limit);
  return {
    messages: messages.slice(start, end), sent: sent.slice(start, end),
    before: start > 0 ? messages[start]!.id : older.before,
    after: end < messages.length ? messages[end - 1]!.id : newer.after,
  };
}

/** A page of `messages.list`, with the turns its messages belong to. */
export interface MessagePage { messages: Message[]; before: string | null; after?: string | null; turns: Turn[] }

/**
 * One page of messages older than `before`, oldest first inside the page, or
 * newer than `after`. A cursor that is not a message of that thread is
 * refused by name rather than answered with an empty page, and so is a call
 * with both cursors or neither.
 */
export function messagePage(core: Core, params: RpcParams<'messages.list'>): MessagePage {
  if ((params.before === undefined) === (params.after === undefined)) {
    throw refused('messages.list takes exactly one cursor: before, for older messages, or after, for newer ones', {
      threadId: params.threadId, field: 'before', expected: 'one of before or after',
    });
  }
  const cursor = (params.before ?? params.after)!;
  const rowid = core.journal.messageRowid(params.threadId, cursor);
  if (rowid === null) {
    throw refused(`message ${cursor} is not a message of thread ${params.threadId}`, {
      threadId: params.threadId,
      ...(params.before === undefined ? { after: cursor } : { before: cursor }),
    });
  }
  const limit = Math.min(Math.max(1, Math.trunc(params.limit ?? MESSAGE_PAGE)), MESSAGE_PAGE_MAX);
  const project = transportProjection(params, params.compactImages ? core.media.lookup(params.threadId) : undefined);
  const previews = toolPreviews(params);
  const turns = (stored: Message[]) => core.journal.listTurnsFor(params.threadId, stored.map((message) => message.turnId));
  if (params.before === undefined) {
    const page = core.journal.listMessagesForward(params.threadId, rowid + 1, limit, project, previews);
    return { messages: page.sent, before: null, after: page.after, turns: turns(page.messages) };
  }
  const page = core.journal.listMessagePage(params.threadId, { beforeRowid: rowid, limit, project, toolPreviews: previews });
  return { messages: page.sent, before: page.before, turns: turns(page.messages) };
}
