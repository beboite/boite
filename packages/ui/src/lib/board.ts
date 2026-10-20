import type { Todo } from '@boite/contracts';

/** The project board's columns, in the order it draws them. */
export type BoardColumn = 'todo' | 'doing' | 'review' | 'done';
export const BOARD_COLUMNS: readonly BoardColumn[] = ['todo', 'doing', 'review', 'done'];

/**
 * Where a card sits: Done once the user confirmed it, In review while its goal
 * is reviewed or it waits for the user, In progress while a `/goal2`
 * conversation holds it, To do otherwise.
 */
export function cardColumn(todo: Todo): BoardColumn {
  if (todo.status === 'done') return 'done';
  if (todo.status === 'claimed' || todo.goal?.reviewing) return 'review';
  return todo.goalThreadId ? 'doing' : 'todo';
}

/** How many cards each column holds, what a project's compact board shows. */
export function columnCounts(todos: readonly Todo[]): Record<BoardColumn, number> {
  const counts: Record<BoardColumn, number> = { todo: 0, doing: 0, review: 0, done: 0 };
  for (const todo of todos) counts[cardColumn(todo)]++;
  return counts;
}
