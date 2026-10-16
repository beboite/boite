import { messageOf } from '../../errors.ts';
import type { SessionContext } from '../types.ts';
import type { CodexThreadOpened } from './protocol.ts';
import type { CodexRpc } from './rpc.ts';

/**
 * What `thread/resume` answers when the thread's rollout file is gone. Both
 * sentences are in the 0.156.1 binary; any other refusal keeps the thread.
 */
const MISSING_THREAD = /no rollout found for (?:thread|conversation) id|thread not found: /i;

/**
 * What `thread/resume` answers for a thread archived in the Codex app or CLI,
 * which share the default account's history: "session <id> is archived. Run
 * `codex unarchive <id>`" in codex 0.162.1. Its history is intact, so the
 * thread is unarchived and resumed instead of failing every turn.
 */
const ARCHIVED_THREAD = /\bsession \S+ is archived\b|\bcodex unarchive\b/i;

/** `thread/resume` refused a thread the agent no longer has. */
/** `sessionLost` tells `noteReady` this is a resume miss the turn recovers from, not a failed open. */
export class ThreadLostError extends Error { readonly sessionLost = true; }

/**
 * `thread/resume` with these params. A thread archived outside Boite is
 * unarchived and resumed once more; a thread whose rollout is gone throws
 * `ThreadLostError`, which the turn recovers from by starting over.
 */
export async function resumeThread(rpc: CodexRpc, ctx: SessionContext, params: { threadId: string } & Record<string, unknown>): Promise<CodexThreadOpened> {
  const lost = (error: unknown): never => {
    const reason = messageOf(error);
    throw MISSING_THREAD.test(reason) ? new ThreadLostError(reason) : error;
  };
  try {
    return await rpc.request<CodexThreadOpened>('thread/resume', params);
  } catch (error) {
    if (!ARCHIVED_THREAD.test(messageOf(error))) return lost(error);
  }
  ctx.log('info', `codex: thread ${params.threadId} was archived outside Boite; unarchiving it to resume`);
  await rpc.request('thread/unarchive', { threadId: params.threadId });
  return rpc.request<CodexThreadOpened>('thread/resume', params).catch(lost);
}
