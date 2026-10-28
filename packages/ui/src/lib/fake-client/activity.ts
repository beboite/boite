/** A thread's goal, loop and task list, and the timer that runs them. */
import { errorText } from '../errors';
import { AUTO_GOAL_MIN_CHARS, attachmentError, RpcErrorCode, threadActive, type AgentTask, type Thread, type ThreadActivity, type Turn } from '@boite/contracts';
import { RpcFailure } from '../client';
import { refusal } from './shared';
import { workflowAnswer, workflowChild } from './delegation';
import type { FakeContext, FakeMethods } from './context';
import { checking, checkTurn, startChecklist, stopChecklist } from './checklist';

/**
 * The in-memory reviewer of a `/goal2`: a child conversation that answers
 * after a moment, FAIL on the first review and PASS after, as a real reviewer
 * of a first attempt with one gap would.
 */
const reviews = new WeakMap<FakeContext, Map<string, { timer: ReturnType<typeof setTimeout>; reviewer: string }>>();
const REVIEW_MS = 1200;
const FAKE_FINDING = '- The empty state still shows the old label in ThreadList.svelte';

function reviewsOf(ctx: FakeContext) {
  let map = reviews.get(ctx);
  if (!map) reviews.set(ctx, map = new Map());
  return map;
}

function startReview(ctx: FakeContext, thread: Thread): void {
  const running = reviewsOf(ctx);
  // The live review: a task list or a loop may have replaced `thread.activity` since the run was scheduled.
  const review = thread.activity?.goal?.review;
  if (running.has(thread.id) || !thread.activity?.goal || review?.phase !== 'reviewing') return;
  const round = review.verdicts.length + 1;
  const objective = thread.activity.goal.objective;
  const route = { id: 'conversation', name: 'Conversation', providerId: thread.providerId, accountId: thread.accountId, model: thread.model, effort: thread.effort };
  const reviewer = workflowChild(ctx, thread, route, `Review ${round} · ${objective}`.slice(0, 120), `Review the goal: ${objective}`);
  review.reviewerThreadId = reviewer;
  ctx.publishActivity(thread);
  const timer = setTimeout(() => {
    running.delete(thread.id);
    // A task list or a loop replaces `thread.activity` with a copy meanwhile: read the goal again.
    const goal = thread.activity?.goal;
    const current = goal?.review;
    if (!goal || current?.reviewerThreadId !== reviewer) return;
    const verdict = current.verdicts.length === 0 ? 'fail' as const : 'pass' as const;
    const summary = verdict === 'fail' ? FAKE_FINDING : 'The label is updated and the list test passes.';
    workflowAnswer(ctx, reviewer, `${summary}\nVERDICT: ${verdict.toUpperCase()}`, true);
    current.verdicts.push({ round, verdict, summary, threadId: reviewer, finishedAt: ctx.now() });
    Object.assign(current, { phase: 'working', reviewerThreadId: null });
    if (verdict === 'pass') goal.status = 'complete';
    ctx.publishActivity(thread);
    scheduleActivity(ctx, thread.id, 250);
  }, REVIEW_MS);
  running.set(thread.id, { timer, reviewer });
}

/** Paused, removed or finished by hand, the goal's reviewer stops. */
function stopReview(ctx: FakeContext, thread: Thread): void {
  const running = reviewsOf(ctx).get(thread.id);
  if (!running) return;
  clearTimeout(running.timer);
  reviewsOf(ctx).delete(thread.id);
  workflowAnswer(ctx, running.reviewer, 'Stopped', false);
  const review = thread.activity?.goal?.review;
  if (review?.reviewerThreadId === running.reviewer) review.reviewerThreadId = null;
}

export function pauseActivity(ctx: FakeContext, thread: Thread): void {
  const timer = ctx.activityTimers.get(thread.id);
  if (timer) clearTimeout(timer);
  ctx.activityTimers.delete(thread.id);
  if (!thread.activity) return;
  stopReview(ctx, thread);
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
    if (ctx.inFlight.has(threadId) || threadActive(thread.status)) return;
    const kind = activity.loop?.status === 'active' && (activity.loop.nextRunAt ?? 0) <= Date.now() ? 'loop' : activity.goal?.status === 'active' ? 'goal' : null;
    if (!kind) {
      if (activity.loop?.status === 'active') scheduleActivity(ctx, threadId, Math.max(0, (activity.loop.nextRunAt ?? Date.now()) - Date.now()));
      return;
    }
    // A check of the last turn decides what the next turn hears, or whether a claim goes back.
    if (kind === 'goal' && checking(ctx, thread)) return;
    if (kind === 'goal' && thread.activity?.goal?.review?.phase === 'reviewing') { startReview(ctx, thread); return; }
    const review = kind === 'goal' ? thread.activity?.goal?.review : undefined;
    try {
      const key = `${threadId}:${kind}`;
      const turn = ctx.startTurn(threadId, kind === 'goal' ? activity.goal!.objective : activity.loop!.prompt, ctx.activityAttachments.get(key) ?? [], undefined, kind);
      ctx.activityAttachments.delete(key);
      ctx.activityTurns.set(turn.id, { kind, generation: ctx.activityGenerations.get(`${threadId}:${kind}`) ?? 0 });
      activity[kind]!.iterations++;
      if (review) review.delivered = review.verdicts.length;
      if (kind === 'loop') {
        activity.loop!.nextRunAt = null;
        activity.loop!.history = [...(activity.loop!.history ?? []), { iteration: activity.loop!.iterations, turnId: turn.id, status: 'running' as const, summary: '', startedAt: Date.now(), finishedAt: null }].slice(-50);
      }
      ctx.publishActivity(thread);
    } catch (error) {
      pauseActivity(ctx, thread);
      activity[kind]!.error = errorText(error);
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
      // The in-memory agent completes its fake goal after one echo turn. An
      // objective that asks a question stands for an agent that cannot answer
      // it alone: the goal stops on a blocker, as a real one ending its answer
      // on the marker would.
      const goal = thread.activity.goal;
      if (owned?.kind === 'goal' && current && goal?.status === 'active') {
        if (goal.objective.trim().endsWith('?')) { goal.status = 'paused'; goal.blocked = true; goal.error = 'The agent reported a blocker. Reply to resume.'; }
        else if (goal.review) Object.assign(goal.review, { phase: 'reviewing', claimTurnId: turn.id });
        else goal.status = 'complete';
        ctx.publishActivity(thread);
      }
      if (goal?.checklist && goal.status !== 'complete') { checkTurn(ctx, thread, () => scheduleActivity(ctx, thread.id, 250)); return; }
      scheduleActivity(ctx, thread.id, 250);
    }
  }
}

type ActivitySet = Parameters<FakeMethods['threads.activity.set']>[0];
type ActivityControl = Parameters<FakeMethods['threads.activity.control']>[0];
type GoalInput = Exclude<ActivitySet['goal'], undefined>;
type LoopInput = Exclude<ActivitySet['loop'], undefined>;

function activityAttachments(ctx: FakeContext, thread: Thread, params: ActivitySet) {
  const attachments = params.attachments ?? [];
  if (!Array.isArray(attachments)) throw refusal('attachments must be an array');
  if (attachments.length) {
    const provider = ctx.providers.find(provider => provider.id === thread.providerId);
    if (!provider) throw ctx.notFound('provider', thread.providerId);
    const error = attachmentError(attachments, provider);
    if (error) throw new RpcFailure({ code: RpcErrorCode.Refused, ...error });
  }
  if (attachments.length && Number(!!params.goal) + Number(!!params.loop) !== 1) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'attachments require exactly one new goal or loop' });
  return attachments;
}

function validateGoal(thread: Thread, goal: GoalInput): RpcFailure | null {
  if (goal !== null && !goal.objective?.trim()) return new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'goal.objective must be non-empty text' });
  if (goal && goal.review !== undefined && typeof goal.review !== 'boolean') return new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'goal.review must be a boolean' });
  if (goal?.review && thread.parentThreadId) return refusal('a reviewed goal starts reviewer conversations; start it in a top-level thread');
  return null;
}

function setGoal(ctx: FakeContext, thread: Thread, activity: ThreadActivity, goal: GoalInput, auto = false): void {
  const error = validateGoal(thread, goal);
  if (error) throw error;
  stopReview(ctx, thread);
  stopChecklist(ctx, thread);
  if (activity.goal?.auto) ctx.unlinkGoalCards(thread);
  activity.goal = goal === null ? null : {
    ...(auto ? { auto: true as const } : {}),
    objective: goal.objective.trim(), status: 'active', iterations: 0, error: null,
    ...(goal.review ? { review: { phase: 'working' as const, maxRounds: 5, reviewerThreadId: null, claimTurnId: null, delivered: 0, verdicts: [] }, checklist: { threadId: null, phase: 'idle' as const, items: [], model: null, effort: null, error: null } } : {}),
  };
}

function validateLoop(loop: LoopInput): RpcFailure | null {
  if (loop !== null && (!loop.prompt?.trim() || !Number.isInteger(loop.intervalMs) || (loop.intervalMs < 1000 && !(loop.intervalMs === 0 && loop.maxIterations)) || loop.intervalMs > 86400000 || (loop.maxIterations != null && (!Number.isInteger(loop.maxIterations) || loop.maxIterations < 1 || loop.maxIterations > 1000)))) return new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'loop requires text and an interval from 1000 to 86400000 ms, or 0 with 1 to 1000 iterations' });
  return null;
}

function setLoop(activity: ThreadActivity, loop: LoopInput): void {
  const error = validateLoop(loop);
  if (error) throw error;
  activity.loop = loop === null ? null : { prompt: loop.prompt.trim(), intervalMs: loop.intervalMs, maxIterations: loop.maxIterations ?? null, status: 'active', iterations: 0, nextRunAt: Date.now(), error: null, history: [] };
}

function updateActivityAttachments(ctx: FakeContext, thread: Thread, params: ActivitySet, attachments: NonNullable<ActivitySet['attachments']>): void {
  for (const kind of ['goal', 'loop'] as const) if (params[kind] !== undefined) {
    const key = `${thread.id}:${kind}`;
    ctx.activityGenerations.set(key, (ctx.activityGenerations.get(key) ?? 0) + 1);
    if (params[kind] && attachments.length) ctx.activityAttachments.set(key, JSON.parse(JSON.stringify(attachments)));
    else ctx.activityAttachments.delete(key);
  }
}

function validateControl(thread: Thread, params: ActivityControl): ThreadActivity {
  const activity = thread.activity;
  if (params.action === 'resume' && thread.archived) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'cannot resume activity on an archived thread' });
  const item = activity?.[params.kind];
  if (!activity || !item) throw new RpcFailure({ code: RpcErrorCode.Refused, message: `this thread has no ${params.kind}` });
  if (params.action === 'complete' && params.kind !== 'goal') throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'only a goal can be completed' });
  if (params.action === 'resume' && params.kind === 'loop' && activity.loop?.maxIterations && activity.loop.iterations >= activity.loop.maxIterations) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this loop has finished all its iterations' });
  return activity;
}

function setActivityStatus(activity: ThreadActivity, kind: ActivityControl['kind'], status: 'active' | 'paused'): void {
  const item = activity[kind]!;
  item.status = status;
  item.error = null;
  if (kind === 'goal' && activity.goal) {
    activity.goal.dismissed = false;
    delete activity.goal.blocked;
  }
}

function completeGoal(activity: ThreadActivity, kind: ActivityControl['kind']): void {
  if (!activity.goal) { setActivityStatus(activity, kind, 'paused'); return; }
  activity.goal.status = 'complete';
  delete activity.goal.blocked;
  if (activity.goal.review) Object.assign(activity.goal.review, { phase: 'working', reviewerThreadId: null });
}

const CONTROL_ACTIONS = new Map<ActivityControl['action'], (activity: ThreadActivity, kind: ActivityControl['kind']) => void>([
  ['remove', (activity, kind) => { activity[kind] = null; }],
  ['complete', completeGoal],
  ['resume', (activity, kind) => setActivityStatus(activity, kind, 'active')],
  ['pause', (activity, kind) => setActivityStatus(activity, kind, 'paused')],
]);

function applyControl(activity: ThreadActivity, params: ActivityControl): void {
  const apply = CONTROL_ACTIONS.get(params.action) ?? CONTROL_ACTIONS.get('pause')!;
  apply(activity, params.kind);
}

function updateLoopClock(activity: ThreadActivity, params: ActivityControl): void {
  if (activity.loop && activity.loop.status !== 'active') activity.loop.nextRunAt = null;
  if (params.kind === 'loop' && params.action === 'resume' && activity.loop) activity.loop.nextRunAt = Date.now();
}

const NATIVE_COMMAND = /^\s*\/[\w:-]+(?:\s|$)/;
const busy = (thread: Thread) => [thread.activity?.goal, thread.activity?.loop].some(item => item && item.status !== 'complete');

/** As the core's `startsAutoGoal`: the sending app had `auto-goal` on, and the prompt, no command, reaches the owner's threshold. */
export function startsAutoGoal(ctx: FakeContext, text: string, experiments: readonly string[] | null | undefined): boolean {
  if (!experiments?.includes('auto-goal') || NATIVE_COMMAND.test(text)) return false;
  return text.trim().length >= (ctx.settings.autoGoalMinChars ?? AUTO_GOAL_MIN_CHARS.default);
}

/** As the core's `ActivityStore.autoGoal`: the prompt of `turnId` becomes a reviewed goal and a linked card. */
export function startAutoGoal(ctx: FakeContext, thread: Thread, turnId: string, objective: string): boolean {
  if (thread.archived || thread.parentThreadId || busy(thread) || !objective.trim()) return false;
  const activity = structuredClone(thread.activity ?? { goal: null, loop: null, tasks: [] });
  setGoal(ctx, thread, activity, { objective, review: true }, true);
  thread.activity = activity;
  ctx.autoGoalTurns.set(thread.id, turnId);
  startChecklist(ctx, thread);
  ctx.publishActivity(thread);
  ctx.addGoalCard(thread, objective);
  scheduleActivity(ctx, thread.id);
  return true;
}

/** The prompt of the newest turn the user started, as the core's `lastPrompt`. */
function lastPrompt(thread: Thread): { turnId: string; text: string } | null {
  for (const message of [...thread.messages].reverse()) {
    if (message.role !== 'user' || !message.turnId || thread.turns.find(turn => turn.id === message.turnId)?.execution?.operation) continue;
    if (thread.messages.find(other => other.turnId === message.turnId)?.id !== message.id) continue;
    const part = message.parts[0];
    if (part?.type !== 'text' || part.activity || part.startedBy) continue;
    const text = part.displayText ?? part.text;
    if (text.trim() && !NATIVE_COMMAND.test(text)) return { turnId: message.turnId, text };
  }
  return null;
}

export function activityMethods(ctx: FakeContext) {
  return {
    'threads.activity.set': async (params) => {
      const thread = ctx.thread(params.threadId);
      if (thread.archived) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'activity requires an unarchived thread' });
      const attachments = activityAttachments(ctx, thread, params);
      const activity = structuredClone(thread.activity ?? { goal: null, loop: null, tasks: [] });
      if (params.goal !== undefined) setGoal(ctx, thread, activity, params.goal);
      if (params.loop !== undefined) setLoop(activity, params.loop);
      updateActivityAttachments(ctx, thread, params, attachments);
      thread.activity = activity;
      if (params.goal?.review) startChecklist(ctx, thread);
      ctx.publishActivity(thread);
      scheduleActivity(ctx, thread.id);
      return structuredClone(activity);
    },
    'threads.goal.track': async (params) => {
      const thread = ctx.thread(params.threadId);
      if (thread.archived) throw refusal('goal track needs an existing, unarchived conversation');
      if (!(ctx.desktopExperiments ?? ctx.clientPreferences?.experiments ?? []).includes('auto-goal')) throw refusal('goal track needs the Automatic goals experiment, which is off in the desktop app (Settings, Experiments)');
      if (busy(thread)) throw refusal('this conversation already has a goal or a loop; it must finish or be removed first');
      const last = lastPrompt(thread);
      if (!last) throw refusal('this conversation has no prompt of the user to track');
      if (ctx.autoGoalTurns.get(thread.id) === last.turnId) throw refusal("the user's last prompt already started a goal");
      if (!startAutoGoal(ctx, thread, last.turnId, last.text)) throw refusal('a reviewed goal starts reviewer conversations; start it in a top-level conversation');
      return structuredClone(thread.activity!);
    },
    'threads.activity.control': async (params) => {
      const thread = ctx.thread(params.threadId);
      const activity = validateControl(thread, params);
      if (params.kind === 'goal' && params.action === 'remove' && activity.goal?.auto) ctx.unlinkGoalCards(thread);
      if (params.kind === 'goal' && params.action !== 'resume') stopReview(ctx, thread);
      if (params.kind === 'goal' && (params.action === 'remove' || params.action === 'complete')) stopChecklist(ctx, thread);
      applyControl(activity, params);
      if (params.action === 'remove' || params.action === 'complete') {
        const key = `${thread.id}:${params.kind}`;
        ctx.activityGenerations.set(key, (ctx.activityGenerations.get(key) ?? 0) + 1);
        ctx.activityAttachments.delete(key);
      }
      updateLoopClock(activity, params);
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
