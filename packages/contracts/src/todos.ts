import type { ProjectId, ThreadId, Timestamp } from './ids';
import type { GoalChecklist } from './threads';
import type { SharedBoardCard } from './shared-projects';

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
  /** The `/goal2` conversation the project board started for this card. Missing on older cores and on a card nobody started. */
  goalThreadId?: ThreadId | null;
  /** That conversation's goal as the board draws it, read on every send and never stored. Missing once the goal is gone. */
  goal?: TodoGoal;
  /** A shared card keeps its canonical association; foreign thread IDs are never local links. */
  shared?: { sharedProjectId: string; card: SharedBoardCard };
}

/**
 * Where a card's `/goal2` stands. The core moves an open card to `claimed`
 * when its goal completes, so the user confirms it like any claimed card.
 */
export interface TodoGoal {
  status: 'active' | 'paused' | 'complete';
  /** A reviewer reads the agent's completion claim. */
  reviewing: boolean;
  /** Null until the goal's tracker wrote its first list. */
  checklist: GoalChecklist | null;
}

export const TODO_STATUSES: readonly Todo['status'][] = ['open', 'claimed', 'done'];

/** A card is a line, not a document: the whole list travels on every change. */
export const TODO_TEXT_MAX = 2000;

export interface TodosRpcMethods {

  /** The project's todo list, the thread naming the project. Done cards last. */
  'todos.list': { params: { threadId: ThreadId }; result: Todo[] };
  'todos.add': { params: { threadId: ThreadId; text: string }; result: Todo };
  /**
   * A status or a text change. An agent moves a card to `claimed`; `done` is the user's confirmation.
   * `goalThreadId` links the card to the `/goal2` conversation the board started for it, a thread of
   * the same project, or unlinks it with null.
   */
  'todos.update': { params: { threadId: ThreadId; todoId: string; status?: Todo['status']; text?: string; goalThreadId?: ThreadId | null; sharedProjectId?: string }; result: Todo };
  'todos.remove': { params: { threadId: ThreadId; todoId: string; sharedProjectId?: string }; result: { ok: true } };
}

export interface TodosRpcEvents {
  /** The project's whole list, after any change. */
  'todos.updated': { projectId: ProjectId; todos: Todo[] };
}
