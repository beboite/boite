import type { RpcEventName, RpcEvents, ThreadId, ThreadProgress } from '@boite/contracts';
import type { FakeContext } from './context';

const published = new WeakMap<FakeContext, Map<ThreadId, number>>();

/** The in-memory transport reports the same observed message events as the real sink. */
export function observeProgress<E extends RpcEventName>(ctx: FakeContext, threadId: ThreadId, event: E, payload: RpcEvents[E]): void {
  if (event !== 'message.started' && event !== 'message.part' && event !== 'message.delta') return;
  const thread = ctx.threads.get(threadId);
  const id = event === 'message.started' ? (payload as RpcEvents['message.started']).id : (payload as RpcEvents['message.part']).messageId;
  const message = thread?.messages.find(message => message.id === id);
  if (!thread || message?.role !== 'assistant') return;
  const turn = thread.turns.find(turn => turn.id === message.turnId);
  if (turn?.status !== 'running') return;
  const part = event === 'message.started' ? message.parts.at(-1) : event === 'message.part'
    ? (payload as RpcEvents['message.part']).part : message.parts[(payload as RpcEvents['message.delta']).partIndex];
  const phase: ThreadProgress['phase'] = part?.type === 'thinking' ? 'thinking' : part?.type === 'tool' && part.status === 'running' ? 'tool' : 'working';
  const detail = part?.type === 'tool' && part.status === 'running' ? part.name : null;
  const old = thread.progress;
  thread.progress = { turnId: turn.id, phase, detail, at: ctx.now(), providerAt: ctx.now() };
  const times = published.get(ctx) ?? new Map<ThreadId, number>();
  published.set(ctx, times);
  if (old?.phase !== phase || old.detail !== detail || ctx.now() - (times.get(threadId) ?? 0) >= 1000) {
    times.set(threadId, ctx.now());
    ctx.touch(thread);
  }
}
