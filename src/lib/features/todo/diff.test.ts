import { describe, expect, it } from "vitest";
import { diffTodos } from "./diff";
import type { TodoItem, TodoState } from "$lib/types";

function todo(id: string, patch: Partial<TodoItem> = {}): TodoItem {
  return {
    id,
    projectId: "p1",
    title: `todo ${id}`,
    description: null,
    state: "open" as TodoState,
    note: null,
    commitSha: null,
    claimedBy: null,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

describe("diffTodos", () => {
  it("sees a row that was not there", () => {
    const d = diffTodos([], [todo("a")]);
    expect(d).toHaveLength(1);
    expect(d[0].change).toBe("added");
    expect(d[0].todo.id).toBe("a");
  });

  it("sees a claim, and remembers what it left", () => {
    const before = [todo("a")];
    const after = [todo("a", { state: "claimed", claimedBy: "claude" })];
    const d = diffTodos(before, after);
    expect(d).toEqual([
      expect.objectContaining({ change: "claimed", from: "open" }),
    ]);
  });

  it("sees done, reopened and removed", () => {
    expect(
      diffTodos([todo("a")], [todo("a", { state: "done" })])[0].change,
    ).toBe("done");
    expect(
      diffTodos([todo("a", { state: "claimed" })], [todo("a")])[0].change,
    ).toBe("reopened");
    expect(diffTodos([todo("a")], [])[0].change).toBe("removed");
  });

  it("says nothing about an edit that is not a state change", () => {
    // A reorder rewrites every row's position and a reword rewrites a title.
    // Announcing either would put a card on screen for work the user did.
    const before = [todo("a"), todo("b")];
    const after = [
      todo("a", { title: "renamed", position: 1, updatedAt: 99 }),
      todo("b", { position: 0, description: "new body" }),
    ];
    expect(diffTodos(before, after)).toEqual([]);
  });

  it("puts what is waiting on the user first", () => {
    // Order is what deserves the screen, not row order: only the first few are
    // ever shown, and a claim is the one that needs an answer.
    const before = [todo("a"), todo("b"), todo("c", { state: "claimed" })];
    const after = [
      todo("a", { state: "done" }),
      todo("b", { state: "claimed" }),
      todo("c"),
      todo("d"),
    ];
    expect(diffTodos(before, after).map((x) => x.change)).toEqual([
      "claimed",
      "done",
      "added",
      "reopened",
    ]);
  });

  it("does not report a row that did not move", () => {
    const same = [todo("a"), todo("b", { state: "done" })];
    expect(diffTodos(same, same.map((t) => ({ ...t })))).toEqual([]);
  });
});
