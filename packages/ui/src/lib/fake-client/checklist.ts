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

/** One item per clause: a line, a sentence or an "and". */
export function draftItems(objective: string): GoalChecklistItem[] {
  const clauses = objective.split(/\n+|[.;!?]\s+|,\s*|\s+(?:and|et|puis|then)\s+/i).map((clause) => clause.trim().replace(/[.;!?]$/, '')).filter((clause) => clause.length > 2);
  return clauses.slice(0, 8).map((source, index) => ({ id: index + 1, text: source.charAt(0).toUpperCase() + source.slice(1, 80), source, status: 'open' }));
}

/** A pass waiting its turn: what it shows while it runs, what it does, and what follows it. */
interface Pass { phase: 'writing' | 'checking'; work: (list: GoalChecklist, goal: Goal) => void; after?: () => void }
interface Passes { running: (Pass & { timer: ReturnType<typeof setTimeout> }) | null; queue: Pass[] }

const passes = new WeakMap<FakeContext, Map<string, Passes>>();

function passesOf(ctx: FakeContext, threadId: string): Passes {
  let map = passes.get(ctx);
  if (!map) passes.set(ctx, map = new Map());
  let entry = map.get(threadId);
  if (!entry) map.set(threadId, entry = { running: null, queue: [] });
  return entry;
}

type Goal = NonNullable<ThreadActivity['goal']>;

/** Passes run one at a time, in the order they were asked for, as the core's tracker runs them. */
function pass(ctx: FakeContext, thread: Thread, item: Pass): void {
  const entry = passesOf(ctx, thread.id);
  entry.queue.push(item);
  if (!entry.running) next(ctx, thread, entry);
}

/** Start the next pass on the live list: a task list or a loop may have replaced `thread.activity` with a copy meanwhile. */
function next(ctx: FakeContext, thread: Thread, entry: Passes): void {
  const item = entry.queue.shift();
  const list = thread.activity?.goal?.checklist;
  if (!item) return;
  if (!list) { entry.queue = []; item.after?.(); return; }
  const tracker = list.threadId;
  list.phase = item.phase;
  ctx.publishActivity(thread);
  entry.running = { ...item, timer: setTimeout(() => {
    entry.running = null;
    const goal = thread.activity?.goal;
    // A goal set again meanwhile has a list and a tracker of its own.
    if (goal?.checklist && goal.checklist.threadId === tracker) {
      item.work(goal.checklist, goal);
      goal.checklist.phase = 'idle';
      ctx.publishActivity(thread);
    }
    item.after?.();
    next(ctx, thread, entry);
  }, PASS_MS) };
}

/** A new `/goal2`: its tracker conversation writes the list. */
export function startChecklist(ctx: FakeContext, thread: Thread): void {
  const goal = thread.activity?.goal;
  const list = goal?.checklist;
  if (!goal || !list) return;
  const route = { id: 'goal-tracker', name: 'Checklist', providerId: thread.providerId, accountId: thread.accountId, model: thread.model, effort: thread.effort };
  const tracker = workflowChild(ctx, thread, route, `Checklist · ${goal.objective}`.slice(0, 120), 'Write the checklist');
  Object.assign(list, { threadId: tracker, model: `${thread.providerId}/${thread.model ?? 'default'}`, effort: thread.effort ?? null });
  pass(ctx, thread, { phase: 'writing', work: (live, current) => {
    live.items = draftItems(current.objective);
    workflowAnswer(ctx, tracker, `\`\`\`json\n${JSON.stringify({ items: live.items.map(({ text, source }) => ({ text, source })) })}\n\`\`\``, true);
  } });
}

/** A message of the user while the goal runs: one more item, marked added. */
export function noteUserMessage(ctx: FakeContext, thread: Thread, text: string): void {
  const goal = thread.activity?.goal;
  const list = goal?.checklist;
  if (!goal || !list || goal.status === 'complete' || !text.trim()) return;
  pass(ctx, thread, { phase: 'writing', work: (live) => {
    const id = Math.max(0, ...live.items.map((item) => item.id)) + 1;
    live.items.push({ id, text: text.trim().slice(0, 80), source: text.trim().slice(0, 200), status: 'open', added: true });
  } });
}

/** True while a check, running or waiting behind other passes, holds the goal's next turn or review. */
export function checking(ctx: FakeContext, thread: Thread): boolean {
  const entry = passesOf(ctx, thread.id);
  return entry.running?.phase === 'checking' || entry.queue.some((item) => item.phase === 'checking');
}

/** A finished turn: tick the next items, then send a claim back while one stays open, at most twice per item. */
export function checkTurn(ctx: FakeContext, thread: Thread, then: () => void): void {
  const goal = thread.activity?.goal;
  const list = goal?.checklist;
  const entry = passesOf(ctx, thread.id);
  // Nothing open and no list on its way: no check to wait for.
  if (!goal || !list || (!list.items.some((item) => item.status === 'open') && !entry.running && !entry.queue.length)) { then(); return; }
  pass(ctx, thread, { phase: 'checking', after: then, work: (live, current) => {
    for (const item of live.items.filter((entry) => entry.status === 'open').slice(0, TICKS)) item.status = 'done';
    const review = current.review;
    const open = live.items.filter((item) => item.status === 'open' && (item.bounced ?? 0) < BOUNCES);
    if (review?.phase === 'reviewing' && open.length) {
      for (const item of open) item.bounced = (item.bounced ?? 0) + 1;
      Object.assign(review, { phase: 'working', claimTurnId: null });
    }
  } });
}

/** The goal ended or was replaced: a pass in flight is dropped, and a tracker still running stops. */
export function stopChecklist(ctx: FakeContext, thread: Thread): void {
  const entry = passesOf(ctx, thread.id);
  if (entry.running) clearTimeout(entry.running.timer);
  entry.running = null;
  entry.queue = [];
  const list = thread.activity?.goal?.checklist;
  if (!list) return;
  list.phase = 'idle';
  // As the core stops the tracker's turn: one still writing the first list ends with the goal.
  if (list.threadId && ctx.threads.get(list.threadId)?.status === 'running') workflowAnswer(ctx, list.threadId, 'Stopped', false);
}
