import type { ProjectId, ThreadId, Timestamp } from './ids';

/**
 * One card of a project's todo list, shared by every thread of the project.
 * `claimed` is a card a thread finished and the user has not confirmed yet.
 */
export interface Todo {
  id: string;
  projectId: ProjectId;
  text: string;
  status: 'open' | 'claimed' | 'done';
  /** The thread that added or last moved it, null when the user did. */
  threadId: ThreadId | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export const TODO_STATUSES: readonly Todo['status'][] = ['open', 'claimed', 'done'];

/** A card is a line, not a document: the whole list travels on every change. */
export const TODO_TEXT_MAX = 2000;

export interface TodosRpcMethods {

  /** The project's todo list, the thread naming the project. Done cards last. */
  'todos.list': { params: { threadId: ThreadId }; result: Todo[] };
  'todos.add': { params: { threadId: ThreadId; text: string }; result: Todo };
  /** A status or a text change. An agent moves a card to `claimed`; `done` is the user's confirmation. */
  'todos.update': { params: { threadId: ThreadId; todoId: string; status?: Todo['status']; text?: string }; result: Todo };
  'todos.remove': { params: { threadId: ThreadId; todoId: string }; result: { ok: true } };
}

export interface TodosRpcEvents {
  /** The project's whole list, after any change. */
  'todos.updated': { projectId: ProjectId; todos: Todo[] };
}
