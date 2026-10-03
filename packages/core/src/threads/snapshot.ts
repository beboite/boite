import { createHash } from 'node:crypto';
import { MESSAGE_PAGE, MESSAGE_PAGE_MAX, previewToolOutputs, previewFileData, resumeAnchor, snapshotOptionsProblem } from '@boite/contracts';
import type { Message, RpcParams, Thread, ThreadSummary } from '@boite/contracts';
import type { Core } from '../core';
import { invalidParams, refused } from '../errors';
import type { AgentState } from './agent-state';
import { readMemoryEvents } from './memory-read';

type Options = Pick<RpcParams<'threads.get'>, 'limit' | 'compactTools' | 'compactFiles' | 'sync' | 'open'>;
const hash = (messages: Message[], options: Options) => createHash('sha256').update(`${!!options.compactTools}:${!!options.compactFiles}:`).update(JSON.stringify(messages)).digest('base64url');

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
  const tail = from === null ? null : core.journal.listMessagesFrom(thread.id, from, limit);
  const page = tail === null ? core.journal.listMessagePage(thread.id, { limit }) : { messages: tail, before: null };
  const turns = core.journal.listTurnsFor(thread.id, page.messages.map(message => message.turnId));
  const anchor = options.sync ? resumeAnchor({ messages: page.messages, turns }) : null;
  const anchorIndex = anchor === null ? -1 : page.messages.findIndex(message => message.id === anchor);
  const proof = anchor === null ? undefined : { from: anchor, hash: hash(page.messages.slice(anchorIndex), options) };
  const known = options.sync && options.sync !== true ? options.sync : undefined;
  const unchanged = tail !== null && after !== undefined && known?.from === after &&
    known.hash === (proof?.from === after ? proof.hash : hash(tail, options));
  const messages = unchanged ? [] : options.compactTools ? previewToolOutputs(page.messages) : page.messages;
  return {
    ...thread,
    ...(tail === null || after === undefined ? {} : { messagesFrom: after }),
    ...(proof ? { messagesSync: proof } : {}),
    ...(unchanged ? { messagesUnchanged: true as const } : {}),
    messages: options.compactFiles ? previewFileData(messages) : messages,
    memoryEvents: readMemoryEvents(core.journal, thread.id),
    commands: state.commands.get(thread.id) ?? [],
    background: state.background.get(thread.id) ?? [],
    activity: core.activity.get(thread.id),
    messagesBefore: page.before,
    turns,
  };
}
