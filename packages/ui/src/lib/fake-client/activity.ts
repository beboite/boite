/** A thread's goal, loop and task list, and the timer that runs them. */
import { RpcErrorCode, type AgentTask, type Thread, type ThreadActivity, type Turn } from '@boite/contracts';
import { RpcFailure } from '../client';
import { refusal } from './shared';
import type { FakeContext, FakeMethods } from './context';

export function pauseActivity(ctx: FakeContext, thread: Thread): void {
  const timer = ctx.activityTimers.get(thread.id);
  if (timer) clearTimeout(timer);
  ctx.activityTimers.delete(thread.id);
  if (!thread.activity) return;
  for (const kind of ['goal', 'loop'] as const) {
    const item = thread.activity[kind];
    if (item?.status === 'active') item.status = 'paused';
  }
  if (thread.activity.loop) thread.activity.loop.nextRunAt = null;
  ctx.publishActivity(thread);
}

function scheduleActivity(ctx: FakeContext, threadId: string, delay = 0): void {
  const old = ctx.activityTimers.get(threadId);
  if (old) clearTimeout(old);
  ctx.activityTimers.delete(threadId);
  const thread = ctx.threads.get(threadId);
  const activity = thread?.activity;
  if (!thread || thread.archived || !activity || (activity.goal?.status !== 'active' && activity.loop?.status !== 'active')) return;
  ctx.activityTimers.set(threadId, setTimeout(() => {
    ctx.activityTimers.delete(threadId);
    if (ctx.inFlight.has(threadId) || ['running', 'queued', 'waiting'].includes(thread.status)) return;
    const kind = activity.loop?.status === 'active' && (activity.loop.nextRunAt ?? 0) <= Date.now() ? 'loop' : activity.goal?.status === 'active' ? 'goal' : null;
    if (!kind) {
      if (activity.loop?.status === 'active') scheduleActivity(ctx, threadId, Math.max(0, (activity.loop.nextRunAt ?? Date.now()) - Date.now()));
      return;
    }
    try {
      const turn = ctx.startTurn(threadId, kind === 'goal' ? activity.goal!.objective : activity.loop!.prompt, [], undefined, kind);
      ctx.activityTurns.set(turn.id, { kind, generation: ctx.activityGenerations.get(`${threadId}:${kind}`) ?? 0 });
      activity[kind]!.iterations++;
      if (kind === 'loop') {
        activity.loop!.nextRunAt = null;
        activity.loop!.history = [...(activity.loop!.history ?? []), { iteration: activity.loop!.iterations, turnId: turn.id, status: 'running' as const, summary: '', startedAt: Date.now(), finishedAt: null }].slice(-50);
      }
      ctx.publishActivity(thread);
    } catch (error) {
      pauseActivity(ctx, thread);
      activity[kind]!.error = error instanceof Error ? error.message : String(error);
      ctx.publishActivity(thread);
    }
  }, delay));
}

/** What a finished turn does to its thread's goal and loop, before `turn.finished` goes out. */
export function finishActivityTurn(ctx: FakeContext, turn: Turn): void {
  const owned = ctx.activityTurns.get(turn.id);
  ctx.activityTurns.delete(turn.id);
  const thread = ctx.threads.get(turn.threadId);
  const current = owned && owned.generation === (ctx.activityGenerations.get(`${turn.threadId}:${owned.kind}`) ?? 0);
  if (thread?.activity) {
    if (owned?.kind === 'loop' && current && thread.activity.loop) {
      const loop = thread.activity.loop;
      const run = loop.history?.find(run => run.turnId === turn.id);
      if (run) {
        run.status = turn.status === 'done' ? 'done' : turn.status === 'stopped' ? 'stopped' : 'error';
        run.finishedAt = turn.finishedAt ?? Date.now();
        run.summary = thread.messages.filter(message => message.turnId === turn.id && message.role === 'assistant').flatMap(message => message.parts.filter(part => part.type === 'text').map(part => part.text)).join('\n').slice(0, 4000);
      }
      if (turn.status === 'done' && loop.maxIterations && loop.iterations >= loop.maxIterations) { loop.status = 'complete'; loop.nextRunAt = null; }
      else if (loop.status === 'active') loop.nextRunAt = Date.now() + loop.intervalMs;
      ctx.publishActivity(thread);
    }
    if (turn.status !== 'done' && (!owned || current)) pauseActivity(ctx, thread);
    else {
      // The in-memory agent completes its fake goal after one echo turn.
      if (owned?.kind === 'goal' && current && thread.activity.goal?.status === 'active') { thread.activity.goal.status = 'complete'; ctx.publishActivity(thread); }
      scheduleActivity(ctx, thread.id, 250);
    }
  }
}

export function activityMethods(ctx: FakeContext) {
  return {
    'threads.activity.set': async (params) => {
      if (ctx.thread(params.threadId).agentSessionId) throw refusal('persistent agent sessions use missions instead of conversation loops');
      const thread = ctx.thread(params.threadId);
      if (thread.archived) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'activity requires an unarchived thread' });
      const activity = structuredClone(thread.activity ?? { goal: null, loop: null, tasks: [] });
      if (params.goal !== undefined) {
        if (params.goal !== null && !params.goal.objective?.trim()) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'goal.objective must be non-empty text' });
        activity.goal = params.goal === null ? null : { objective: params.goal.objective.trim(), status: 'active', iterations: 0, error: null };
      }
      if (params.loop !== undefined) {
        if (params.loop !== null && (!params.loop.prompt?.trim() || !Number.isInteger(params.loop.intervalMs) || (params.loop.intervalMs < 1000 && !(params.loop.intervalMs === 0 && params.loop.maxIterations)) || params.loop.intervalMs > 86400000 || (params.loop.maxIterations != null && (!Number.isInteger(params.loop.maxIterations) || params.loop.maxIterations < 1 || params.loop.maxIterations > 1000)))) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'loop requires text and an interval from 1000 to 86400000 ms, or 0 with 1 to 1000 iterations' });
        activity.loop = params.loop === null ? null : { prompt: params.loop.prompt.trim(), intervalMs: params.loop.intervalMs, maxIterations: params.loop.maxIterations ?? null, status: 'active', iterations: 0, nextRunAt: Date.now(), error: null, history: [] };
      }
      for (const kind of ['goal', 'loop'] as const) if (params[kind] !== undefined) {
        const key = `${thread.id}:${kind}`;
        ctx.activityGenerations.set(key, (ctx.activityGenerations.get(key) ?? 0) + 1);
      }
      thread.activity = activity;
      ctx.publishActivity(thread);
      scheduleActivity(ctx, thread.id);
      return structuredClone(activity);
    },
    'threads.activity.control': async (params) => {
      const thread = ctx.thread(params.threadId);
      const activity = thread.activity;
      if (params.action === 'resume' && thread.archived) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'cannot resume activity on an archived thread' });
      const item = activity?.[params.kind];
      if (!activity || !item) throw new RpcFailure({ code: RpcErrorCode.Refused, message: `this thread has no ${params.kind}` });
      if (params.action === 'complete' && params.kind !== 'goal') throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'only a goal can be completed' });
      if (params.action === 'resume' && params.kind === 'loop' && activity.loop?.maxIterations && activity.loop.iterations >= activity.loop.maxIterations) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this loop has finished all its iterations' });
      if (params.action === 'remove') activity[params.kind] = null;
      else if (params.action === 'complete' && activity.goal) activity.goal.status = 'complete';
      else { item.status = params.action === 'resume' ? 'active' : 'paused'; item.error = null; if (params.kind === 'goal' && activity.goal) activity.goal.dismissed = false; }
      if (params.action === 'remove' || params.action === 'complete') {
        const key = `${thread.id}:${params.kind}`;
        ctx.activityGenerations.set(key, (ctx.activityGenerations.get(key) ?? 0) + 1);
      }
      if (activity.loop && activity.loop.status !== 'active') activity.loop.nextRunAt = null;
      if (params.kind === 'loop' && params.action === 'resume' && activity.loop) activity.loop.nextRunAt = Date.now();
      ctx.publishActivity(thread);
      scheduleActivity(ctx, thread.id);
      return structuredClone(activity);
    },
    'threads.tasks.set': async (params) => {
      const thread = ctx.thread(params.threadId);
      const activity: ThreadActivity = structuredClone(thread.activity ?? { goal: null, loop: null, tasks: [] });
      activity.tasks = params.tasks.map((task): AgentTask => ({ id: task.id, text: task.text, status: task.status }));
      // A fresh list is something new to look at, so a dismissal does not hold.
      activity.tasksDismissed = false;
      thread.activity = activity;
      ctx.publishActivity(thread);
      return structuredClone(activity);
    },
    'threads.tasks.get': async (params) => {
      return structuredClone(ctx.thread(params.threadId).activity?.tasks ?? []);
    },
  } satisfies Partial<FakeMethods>;
}
