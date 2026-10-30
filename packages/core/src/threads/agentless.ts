/**
 * A team chat (`docs/teams.md`) runs no agent. Every call that would reach a
 * provider on a thread takes it through here: turns, steering, recovery,
 * titles, compaction, rewind, fork, move, side requests, selection and goals.
 */
import type { ThreadId, ThreadSummary } from '@boite/contracts';
import { refused } from '../errors.ts';

export function requireAgent(threads: { require(threadId: ThreadId): ThreadSummary }, threadId: ThreadId): ThreadSummary {
  const thread = threads.require(threadId);
  if (thread.teamId) throw refused('a team chat runs no agent; post to it through teams.post', { threadId });
  return thread;
}
