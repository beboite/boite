/**
 * The in-memory tracker of a `/goal2`: a child conversation that writes one
 * item per clause of the objective, adds one per later message of the user,
 * and after each turn of the agent ticks the next two open items, as a real
 * tracker reading a goal worked through in steps would.
 */
import type { GoalChecklist, GoalChecklistItem, Thread, ThreadActivity } from '@boite/contracts';
import { workflowAnswer, workflowChild } from './delegation';
import type { FakeContext } from './context';

const PASS_MS = 700;
/** Items a check ticks per turn. */
const TICKS = 2;
/** Claims one open item sends back before the review decides alone, as on the core. */
const BOUNCES = 2;

const timers = new WeakMap<FakeContext, Map<string, ReturnType<typeof setTimeout>>>();

function timersOf(ctx: FakeContext) {
  let map = timers.get(ctx);
  if (!map) timers.set(ctx, map = new Map());
  return map;
}

/** One item per clause: a line, a sentence or an "and". */
export function draftItems(objective: string): GoalChecklistItem[] {
  const clauses = objective.split(/\n+|[.;!?]\s+|,\s*|\s+(?:and|et|puis|then)\s+/i).map((clause) => clause.trim().replace(/[.;!?]$/, '')).filter((clause) => clause.length > 2);
  return clauses.slice(0, 8).map((source, index) => ({ id: index + 1, text: source.charAt(0).toUpperCase() + source.slice(1, 80), source, status: 'open' }));
}

type Goal = NonNullable<ThreadActivity['goal']>;

/** One pass on the live list: a task list or a loop may have replaced `thread.activity` with a copy meanwhile. */
function pass(ctx: FakeContext, thread: Thread, phase: 'writing' | 'checking', work: (list: GoalChecklist, goal: Goal) => void): void {
  const list = thread.activity?.goal?.checklist;
  if (!list) return;
  const tracker = list.threadId;
  const running = timersOf(ctx);
  clearTimeout(running.get(thread.id));
  list.phase = phase;
  ctx.publishActivity(thread);
  running.set(thread.id, setTimeout(() => {
    running.delete(thread.id);
    const goal = thread.activity?.goal;
    // A goal set again meanwhile has a list and a tracker of its own.
    if (!goal?.checklist || goal.checklist.threadId !== tracker) return;
    work(goal.checklist, goal);
    goal.checklist.phase = 'idle';
    ctx.publishActivity(thread);
  }, PASS_MS));
}

/** A new `/goal2`: its tracker conversation writes the list. */
export function startChecklist(ctx: FakeContext, thread: Thread): void {
  const goal = thread.activity?.goal;
  const list = goal?.checklist;
  if (!goal || !list) return;
  const route = { id: 'goal-tracker', name: 'Checklist', providerId: thread.providerId, accountId: thread.accountId, model: thread.model, effort: thread.effort };
  const tracker = workflowChild(ctx, thread, route, `Checklist · ${goal.objective}`.slice(0, 120), 'Write the checklist');
  Object.assign(list, { threadId: tracker, model: `${thread.providerId}/${thread.model ?? 'default'}`, effort: thread.effort ?? null });
  pass(ctx, thread, 'writing', (live, current) => {
    live.items = draftItems(current.objective);
    workflowAnswer(ctx, tracker, `\`\`\`json\n${JSON.stringify({ items: live.items.map(({ text, source }) => ({ text, source })) })}\n\`\`\``, true);
  });
}

/** A message of the user while the goal runs: one more item, marked added. */
export function noteUserMessage(ctx: FakeContext, thread: Thread, text: string): void {
  const goal = thread.activity?.goal;
  const list = goal?.checklist;
  if (!goal || !list || goal.status === 'complete' || !text.trim()) return;
  pass(ctx, thread, 'writing', (live) => {
    const id = Math.max(0, ...live.items.map((item) => item.id)) + 1;
    live.items.push({ id, text: text.trim().slice(0, 80), source: text.trim().slice(0, 200), status: 'open', added: true });
  });
}

/** True while a check holds the goal's next turn or review. */
export function checking(thread: Thread): boolean {
  return thread.activity?.goal?.checklist?.phase === 'checking';
}

/** A finished turn: tick the next items, then send a claim back while one stays open, at most twice per item. */
export function checkTurn(ctx: FakeContext, thread: Thread, then: () => void): void {
  const goal = thread.activity?.goal;
  const list = goal?.checklist;
  if (!goal || !list || !list.items.some((item) => item.status === 'open')) { then(); return; }
  pass(ctx, thread, 'checking', (live, current) => {
    for (const item of live.items.filter((entry) => entry.status === 'open').slice(0, TICKS)) item.status = 'done';
    const review = current.review;
    const open = live.items.filter((item) => item.status === 'open' && (item.bounced ?? 0) < BOUNCES);
    if (review?.phase === 'reviewing' && open.length) {
      for (const item of open) item.bounced = (item.bounced ?? 0) + 1;
      Object.assign(review, { phase: 'working', claimTurnId: null });
    }
  });
  // After the pass's own timer: the list is idle again when the goal moves on.
  setTimeout(then, PASS_MS + 10);
}

/** The goal ended or was replaced: a pass in flight is dropped. */
export function stopChecklist(ctx: FakeContext, thread: Thread): void {
  const running = timersOf(ctx);
  clearTimeout(running.get(thread.id));
  running.delete(thread.id);
  const list = thread.activity?.goal?.checklist;
  if (list) list.phase = 'idle';
}
