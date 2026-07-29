import type { TodoItem } from "$lib/types";

/**
 * What changed in the todo list, when the change came from outside.
 *
 * The store replaces its whole array on reload, so "an agent added something"
 * and "an agent claimed something" arrive as the same event: a new list. This
 * turns two lists into the sentence to show.
 */
export type TodoChange = "added" | "claimed" | "done" | "reopened" | "removed";

export interface TodoDelta {
  change: TodoChange;
  todo: TodoItem;
  /** The state it left, for anything that wants to describe the move. */
  from: TodoItem["state"] | null;
}

/**
 * Deltas between two snapshots of the list, newest-looking first.
 *
 * Ordered by what deserves the screen rather than by row order: a claim is
 * waiting on the user and outranks an add, which outranks a row quietly
 * disappearing. Only the state transition counts as a change — an agent
 * rewording a title is not an event worth interrupting for, and a `position`
 * shuffle from a reorder would otherwise announce the whole list.
 */
export function diffTodos(before: TodoItem[], after: TodoItem[]): TodoDelta[] {
  const prev = new Map(before.map((t) => [t.id, t]));
  const next = new Map(after.map((t) => [t.id, t]));
  const out: TodoDelta[] = [];

  for (const todo of after) {
    const old = prev.get(todo.id);
    if (!old) {
      out.push({ change: "added", todo, from: null });
      continue;
    }
    if (old.state === todo.state) continue;
    if (todo.state === "claimed") {
      out.push({ change: "claimed", todo, from: old.state });
    } else if (todo.state === "done") {
      out.push({ change: "done", todo, from: old.state });
    } else if (old.state !== "open") {
      out.push({ change: "reopened", todo, from: old.state });
    }
  }

  for (const todo of before) {
    if (!next.has(todo.id)) out.push({ change: "removed", todo, from: todo.state });
  }

  const rank: Record<TodoChange, number> = {
    claimed: 0,
    done: 1,
    added: 2,
    reopened: 3,
    removed: 4,
  };
  return out.sort((a, b) => rank[a.change] - rank[b.change]);
}
