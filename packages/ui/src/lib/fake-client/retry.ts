import type { ThreadRetry } from '@boite/contracts';
import type { FakeContext, FakeMethods } from './context';

const MINUTE = 60_000;

/**
 * `?retry=capacity` shows a running thread waiting for its second try after
 * the model was at capacity, `?retry=usage-limit` a failed thread that resumes
 * once its usage window resets, `?retry=auto-continue` a failed thread that
 * resumes by itself in a minute: the core's automatic retries, for captures.
 */
export function seedRetry(ctx: FakeContext): void {
  const kind = new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get('retry');
  if (kind !== 'capacity' && kind !== 'usage-limit' && kind !== 'auto-continue') return;
  const thread = ctx.threads.get(kind === 'capacity' ? 't-scheduler' : 't-trace');
  const turn = thread?.turns.at(-1);
  if (!thread || !turn) return;
  // Real time, not the fake's clock: the banner counts down against the screen's own.
  const now = Date.now();
  const retry: ThreadRetry = kind === 'capacity'
    ? { kind, turnId: turn.id, at: now + 2 * MINUTE, attempt: 2, attempts: 3, resetsAt: null }
    : kind === 'auto-continue'
      ? { kind, turnId: turn.id, at: now + MINUTE, attempt: 1, attempts: 2, resetsAt: null }
      : { kind, turnId: turn.id, at: now + 95 * MINUTE, attempt: 1, attempts: 1, resetsAt: now + 94 * MINUTE };
  thread.retry = retry;
}

export function planRetry(ctx: FakeContext, threadId: string, retry: ThreadRetry): void {
  const thread = ctx.thread(threadId);
  thread.retry = retry;
  ctx.touch(thread);
}

/** As the core: a planned retry goes; a capacity retry's turn then fails with the refusal. */
export function retryMethods(ctx: FakeContext): Pick<FakeMethods, 'turns.cancelRetry'> {
  return {
    'turns.cancelRetry': async ({ threadId }) => {
      const thread = ctx.thread(threadId);
      if (!thread.retry) return { cancelled: false };
      thread.retry = null;
      ctx.touch(thread);
      return { cancelled: true };
    },
  };
}
