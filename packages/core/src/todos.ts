/*
 * The project's todo list: cards the user writes and the agents of that
 * project read, claim and add to. One row per project in the journal's
 * settings table, because the list is small, shared, and read far more often
 * than it changes; every change goes out as `todos.updated` with the whole
 * list, so a second client never rebuilds it from a delta.
 *
 * `done` is the user's word: an agent that finished a card moves it to
 * `claimed` and the card waits there until a person confirms it.
 *
 * The project board starts a `/goal2` conversation for a card and links it
 * (`goalThreadId`). Every send reads that goal again, so the board draws its
 * checklist and review without subscribing to each conversation, and a goal
 * that completes moves its open card to `claimed`.
 */

import { TODO_STATUSES, TODO_TEXT_MAX } from '@boite/contracts';
import type { Principal, ProjectId, RpcEvents, RpcParams, ThreadActivity, ThreadId, Todo, TodoGoal } from '@boite/contracts';
import type { Core } from './core.ts';
import { refused } from './errors.ts';
import { newId } from './ids.ts';

const ORDER: Record<Todo['status'], number> = { open: 0, claimed: 1, done: 2 };

/**
 * How many open or claimed cards a project may hold before an agent's add is
 * refused. Every change rewrites and sends the whole list, so an agent looping
 * on `todos.add` would make each one heavier; the user's own adds are not capped.
 */
export const AGENT_OPEN_TODOS_MAX = 200;

function key(projectId: ProjectId): string {
  return `todos:${projectId}`;
}

function isTodo(value: unknown): value is Todo {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<Todo>;
  return typeof row.id === 'string' && typeof row.text === 'string' && TODO_STATUSES.includes(row.status as Todo['status']);
}

/** What is stored, oldest first, ignoring a row an older version left in a shape nobody reads. */
function stored(core: Core, projectId: ProjectId): Todo[] {
  const saved = core.journal.getSetting(key(projectId));
  if (!Array.isArray(saved)) return [];
  return saved.filter(isTodo).map(({ goal: _goal, ...todo }) => ({ ...todo, projectId }));
}

/** A `/goal2`'s state as a card shows it; null for a plain goal, a loop or no goal. */
export function goalOf(activity: ThreadActivity): TodoGoal | null {
  const goal = activity.goal;
  if (!goal?.review) return null;
  return { status: goal.status, reviewing: goal.review.phase === 'reviewing', checklist: goal.checklist ?? null };
}

/**
 * The conversation a card still links: one removed since, or moved to another
 * project, no longer counts, so its goal never reaches the old project's agents.
 */
function liveLink(core: Core, todo: Todo): ThreadId | null {
  if (!todo.goalThreadId) return null;
  return core.journal.getThread(todo.goalThreadId)?.projectId === todo.projectId ? todo.goalThreadId : null;
}

/** Each linked card with its goal read now; a link that no longer counts is sent as none. */
function withGoals(core: Core, todos: Todo[]): Todo[] {
  return todos.map((todo) => {
    if (!todo.goalThreadId) return todo;
    const link = liveLink(core, todo);
    if (link === null) return { ...todo, goalThreadId: null };
    const goal = goalOf(core.activity.get(link));
    return goal ? { ...todo, goal } : todo;
  });
}

/** Open first, then what a thread claimed, then what the user confirmed, each newest first. */
export function orderTodos(todos: Todo[]): Todo[] {
  return todos
    .map((todo, index) => ({ todo, index }))
    .sort((a, b) =>
      ORDER[a.todo.status] - ORDER[b.todo.status] ||
      b.todo.createdAt - a.todo.createdAt ||
      b.index - a.index)
    .map((entry) => entry.todo);
}

/** Per project, the conversations its cards link, so a goal moving elsewhere costs no read of the list. */
const links = new WeakMap<Core, Map<ProjectId, Set<ThreadId>>>();

function linkedThreads(core: Core, projectId: ProjectId): Set<ThreadId> {
  let projects = links.get(core);
  if (!projects) links.set(core, projects = new Map());
  let linked = projects.get(projectId);
  if (!linked) projects.set(projectId, linked = linkedIn(stored(core, projectId)));
  return linked;
}

function linkedIn(todos: Todo[]): Set<ThreadId> {
  return new Set(todos.flatMap((todo) => todo.goalThreadId ? [todo.goalThreadId] : []));
}

function save(core: Core, projectId: ProjectId, todos: Todo[]): Todo[] {
  core.journal.setSetting(key(projectId), todos);
  links.get(core)?.set(projectId, linkedIn(todos));
  return send(core, projectId, todos);
}

function send(core: Core, projectId: ProjectId, todos: Todo[]): Todo[] {
  const list = orderTodos([...withGoals(core, todos), ...(core.sharedBoard?.todos(projectId) ?? [])]);
  core.bus.emit('todos.updated', { projectId, todos: list });
  return list;
}

/** The project a thread belongs to: the agent names its thread, never a project of its own. */
export function projectOfThread(core: Core, threadId: ThreadId): ProjectId {
  return core.projects.require(core.threads.require(threadId).projectId).id;
}

function checkText(text: unknown): string {
  if (typeof text !== 'string' || text.trim().length === 0) throw refused('a todo needs text', {});
  const trimmed = text.trim();
  if (trimmed.length > TODO_TEXT_MAX) {
    throw refused(`a todo is at most ${TODO_TEXT_MAX} characters, this one is ${trimmed.length}`, { length: trimmed.length });
  }
  return trimmed;
}

export function listTodos(core: Core, threadId: ThreadId): Todo[] {
  const projectId = projectOfThread(core, threadId);
  linkedThreads(core, projectId);
  return orderTodos([...withGoals(core, stored(core, projectId)), ...(core.sharedBoard?.todos(projectId) ?? [])]);
}

/** Replication invalidates the same project board without persisting foreign cards as local ones. */
export function notifySharedTodos(core: Core, projectId: ProjectId): void { send(core, projectId, stored(core, projectId)); }

export function addTodo(core: Core, params: RpcParams<'todos.add'>, principal: Principal = 'owner'): Todo {
  const projectId = projectOfThread(core, params.threadId);
  const todos = stored(core, projectId);
  if (principal === 'agent') {
    const pending = todos.filter((todo) => todo.status !== 'done').length;
    if (pending >= AGENT_OPEN_TODOS_MAX) {
      throw refused(`an agent adds a card only while the project holds fewer than ${AGENT_OPEN_TODOS_MAX} open or claimed cards, this one has ${pending}`, {
        limit: AGENT_OPEN_TODOS_MAX,
        count: pending,
        principal,
      });
    }
  }
  const now = Date.now();
  const todo: Todo = {
    id: newId('todo_'),
    projectId,
    text: checkText(params.text),
    status: 'open',
    threadId: params.threadId,
    createdAt: now,
    updatedAt: now,
  };
  save(core, projectId, [...todos, todo]);
  return todo;
}

export function updateTodo(core: Core, params: RpcParams<'todos.update'>, principal: Principal = 'owner'): Todo {
  // Claiming asks the user to confirm; the confirmation itself is the user's,
  // on this machine or on a device paired to it.
  if (principal === 'agent' && params.status === 'done') {
    throw refused("todos.update status done is the owner's: an agent claims a card, the user confirms it", {
      status: params.status,
      principal,
    });
  }
  const projectId = projectOfThread(core, params.threadId);
  const todos = stored(core, projectId);
  const current = todos.find((todo) => todo.id === params.todoId);
  if (current === undefined) throw refused(`unknown todo ${params.todoId}`, { todoId: params.todoId });
  if (params.status !== undefined && !TODO_STATUSES.includes(params.status)) {
    throw refused(`a todo is ${TODO_STATUSES.join(', ')}, not ${String(params.status)}`, { status: params.status });
  }
  // A card the user confirmed is the user's. An agent used to be able to move
  // it back to open and rewrite its text, undoing the confirmation in silence.
  if (principal === 'agent' && current.status === 'done') {
    throw refused(`todo ${params.todoId} is done: only the user reopens a card they confirmed`, {
      todoId: params.todoId,
      status: current.status,
      principal,
    });
  }
  // Two agents used to be able to claim the same card: both calls succeeded and
  // the second silently took the attribution. Claiming is a transition out of
  // open, so it only holds while the card is still open.
  if (principal === 'agent' && params.status === 'claimed' && current.status !== 'open') {
    throw refused(`todo ${params.todoId} is already ${current.status}`, {
      todoId: params.todoId,
      status: current.status,
      principal,
    });
  }
  if (params.goalThreadId) {
    const goalThread = core.journal.getThread(params.goalThreadId);
    if (!goalThread || goalThread.projectId !== projectId) {
      throw refused(`goalThreadId ${params.goalThreadId} is not a conversation of this card's project`, { goalThreadId: params.goalThreadId, projectId });
    }
    // Two devices putting the same card in progress each make a conversation:
    // the first link wins, and the other learns it before starting a goal.
    const linked = liveLink(core, current);
    if (linked !== null && linked !== params.goalThreadId) {
      throw refused(`todo ${params.todoId} already works in conversation ${linked}; unlink it with goalThreadId null first`, {
        todoId: params.todoId,
        goalThreadId: linked,
        reason: 'already-linked',
      });
    }
  }
  const updated: Todo = {
    ...current,
    ...(params.status === undefined ? {} : { status: params.status }),
    ...(params.text === undefined ? {} : { text: checkText(params.text) }),
    ...(params.goalThreadId === undefined ? {} : { goalThreadId: params.goalThreadId }),
    // The last hand on the card, so the list says which thread moved it.
    threadId: params.threadId,
    updatedAt: Date.now(),
  };
  const list = save(core, projectId, todos.map((todo) => (todo.id === updated.id ? updated : todo)));
  return list.find((todo) => todo.id === updated.id && !todo.shared) ?? updated;
}

/**
 * A linked conversation's goal moved: the board hears it. A goal whose review
 * passed after its card last moved takes the open card to `claimed`, which the
 * user confirms; a card moved back to work after that pass stays where it is.
 */
function followGoal(core: Core, threadId: ThreadId, sent: Map<ThreadId, string>): void {
  const projectId = core.journal.getThread(threadId)?.projectId;
  if (!projectId || !linkedThreads(core, projectId).has(threadId)) return;
  const activity = core.activity.get(threadId);
  const goal = goalOf(activity);
  const seen = JSON.stringify(goal);
  if (sent.get(threadId) === seen) return;
  sent.set(threadId, seen);
  const todos = stored(core, projectId);
  // A pass, not any verdict: a goal the user completes by hand after a failed review claims nothing.
  const verdict = activity.goal?.review?.verdicts.at(-1);
  const passedAt = goal?.status === 'complete' && verdict?.verdict === 'pass' ? verdict.finishedAt : null;
  const claims = (todo: Todo) => passedAt !== null && todo.goalThreadId === threadId && todo.status === 'open' && todo.updatedAt < passedAt;
  if (!todos.some(claims)) { send(core, projectId, todos); return; }
  save(core, projectId, todos.map((todo) => claims(todo) ? { ...todo, status: 'claimed', threadId, updatedAt: Date.now() } : todo));
}

export function removeTodo(core: Core, params: RpcParams<'todos.remove'>): void {
  const projectId = projectOfThread(core, params.threadId);
  const todos = stored(core, projectId);
  if (!todos.some((todo) => todo.id === params.todoId)) {
    throw refused(`unknown todo ${params.todoId}`, { todoId: params.todoId });
  }
  save(core, projectId, todos.filter((todo) => todo.id !== params.todoId));
}

export function registerTodoMethods(core: Core): void {
  // The goal each linked conversation was last sent with, so a save that leaves it as it was sends nothing.
  const sent = new Map<ThreadId, string>();
  core.bus.onAny((name, payload) => {
    if (name === 'thread.activity') followGoal(core, (payload as RpcEvents['thread.activity']).threadId, sent);
    // A linked conversation moved to another project lets go of its card for good;
    // a removed one, which a restore may bring back, only stops showing.
    else if (name === 'thread.updated') {
      const thread = payload as RpcEvents['thread.updated'];
      for (const [linking, linked] of links.get(core) ?? []) {
        if (!linked.has(thread.id) || linking === thread.projectId) continue;
        const now = Date.now();
        save(core, linking, stored(core, linking).map((todo) => todo.goalThreadId === thread.id ? { ...todo, goalThreadId: null, updatedAt: now } : todo));
      }
    } else if (name === 'thread.removed') {
      const { threadId } = payload as RpcEvents['thread.removed'];
      for (const [linking, linked] of links.get(core) ?? []) if (linked.has(threadId)) send(core, linking, stored(core, linking));
    }
  });
  core.router.register('todos.list', (params, ctx) => core.sharedBoard.visibleTodos(params.threadId, listTodos(core, params.threadId), ctx.connection));
  core.router.register('todos.add', (params, ctx) => addTodo(core, params, ctx.connection.identity.principal));
  core.router.register('todos.update', (params, ctx) => params.sharedProjectId ? core.sharedBoard.updateTodo(params, ctx.connection) : updateTodo(core, params, ctx.connection.identity.principal));
  // Deleting a card is the user's: an agent that is done with one claims it.
  core.router.register('todos.remove', async (params, ctx) => {
    if (params.sharedProjectId) {
      await core.sharedBoard.apply({threadId: params.threadId, sharedProjectId: params.sharedProjectId, command: {kind: 'remove', cardId: params.todoId, requestId: newId('remove_')}}, ctx.connection);
      return {ok: true} as const;
    }
    removeTodo(core, params);
    return { ok: true } as const;
  });
}
