/*
 * The project's todo list: cards the user writes and the agents of that
 * project read, claim and add to. One row per project in the journal's
 * settings table, because the list is small, shared, and read far more often
 * than it changes; every change goes out as `todos.updated` with the whole
 * list, so a second client never rebuilds it from a delta.
 *
 * `done` is the user's word: an agent that finished a card moves it to
 * `claimed` and the card waits there until a person confirms it.
 */

import { TODO_STATUSES } from '@boite/contracts';
import type { Principal, ProjectId, RpcParams, ThreadId, Todo } from '@boite/contracts';
import type { Core } from './core.ts';
import { refused } from './errors.ts';
import { newId } from './ids.ts';

/** A card is a line, not a document: the whole list travels on every change. */
export const TODO_TEXT_MAX = 2000;

const ORDER: Record<Todo['status'], number> = { open: 0, claimed: 1, done: 2 };

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
  return saved.filter(isTodo).map((todo) => ({ ...todo, projectId }));
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

function save(core: Core, projectId: ProjectId, todos: Todo[]): Todo[] {
  core.journal.setSetting(key(projectId), todos);
  const list = orderTodos(todos);
  core.bus.emit('todos.updated', { projectId, todos: list });
  return list;
}

/** The project a thread belongs to: the agent names its thread, never a project of its own. */
export function projectOfThread(core: Core, threadId: ThreadId): ProjectId {
  return core.threads.require(threadId).projectId;
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
  return orderTodos(stored(core, projectOfThread(core, threadId)));
}

export function addTodo(core: Core, params: RpcParams<'todos.add'>): Todo {
  const projectId = projectOfThread(core, params.threadId);
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
  save(core, projectId, [...stored(core, projectId), todo]);
  return todo;
}

export function updateTodo(core: Core, params: RpcParams<'todos.update'>, principal: Principal = 'owner'): Todo {
  // Claiming asks the user to confirm; the confirmation itself is the user's.
  if (principal !== 'owner' && params.status === 'done') {
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
  if (principal !== 'owner' && current.status === 'done') {
    throw refused(`todo ${params.todoId} is done: only the user reopens a card they confirmed`, {
      todoId: params.todoId,
      status: current.status,
      principal,
    });
  }
  // Two agents used to be able to claim the same card: both calls succeeded and
  // the second silently took the attribution. Claiming is a transition out of
  // open, so it only holds while the card is still open.
  if (principal !== 'owner' && params.status === 'claimed' && current.status !== 'open') {
    throw refused(`todo ${params.todoId} is already ${current.status}`, {
      todoId: params.todoId,
      status: current.status,
      principal,
    });
  }
  const updated: Todo = {
    ...current,
    ...(params.status === undefined ? {} : { status: params.status }),
    ...(params.text === undefined ? {} : { text: checkText(params.text) }),
    // The last hand on the card, so the list says which thread moved it.
    threadId: params.threadId,
    updatedAt: Date.now(),
  };
  save(core, projectId, todos.map((todo) => (todo.id === updated.id ? updated : todo)));
  return updated;
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
  core.router.register('todos.list', (params) => listTodos(core, params.threadId));
  core.router.register('todos.add', (params) => addTodo(core, params));
  core.router.register('todos.update', (params, ctx) => updateTodo(core, params, ctx.connection.identity.principal));
  // Deleting a card is the user's: an agent that is done with one claims it.
  core.router.register('todos.remove', (params) => {
    removeTodo(core, params);
    return { ok: true } as const;
  });
}
