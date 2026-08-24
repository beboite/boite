import { beforeEach, describe, expect, it } from "vitest";
import { notifications } from "$lib/features/notifications/store.svelte";
import { todoAnnouncer } from "./announce.svelte";
import type { TodoDelta } from "./diff";
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

function delta(change: TodoDelta["change"], item: TodoItem): TodoDelta {
  return { change, todo: item, from: change === "added" ? null : "open" };
}

function clearToasts() {
  while (notifications.toasts.length > 0) {
    notifications.dismiss(notifications.toasts[0].id);
  }
}

describe("todo announcements are ordinary toasts", () => {
  beforeEach(() => {
    todoAnnouncer.reset();
    clearToasts();
  });

  it("raises a new todo on the same stack as everything else", () => {
    todoAnnouncer.push([delta("added", todo("a", { title: "Wire MCP" }))]);
    expect(notifications.toasts).toHaveLength(1);
    expect(notifications.toasts[0]).toMatchObject({
      kind: "info",
      message: "Wire MCP",
      detail: "New todo",
    });
  });

  it("keeps two todos as two cards", () => {
    todoAnnouncer.push([
      delta("added", todo("a", { title: "One" })),
      delta("added", todo("b", { title: "Two" })),
    ]);
    expect(notifications.toasts.map((t) => t.message)).toEqual(["One", "Two"]);
  });

  it("a claim is a warning, with who is waiting", () => {
    todoAnnouncer.push([
      delta("claimed", todo("a", { title: "Deploy", claimedBy: "claude" })),
    ]);
    expect(notifications.toasts[0]).toMatchObject({
      kind: "warning",
      message: "Deploy",
      detail: "Waiting on you · by claude",
    });
  });

  it("done is a success", () => {
    todoAnnouncer.push([delta("done", todo("a", { title: "Ship it" }))]);
    expect(notifications.toasts[0]).toMatchObject({
      kind: "success",
      message: "Ship it",
      detail: "Done",
    });
  });

  it("drops those cards on a workspace switch, and leaves others", () => {
    notifications.success("Commit created");
    todoAnnouncer.push([delta("added", todo("a", { title: "Wire MCP" }))]);
    todoAnnouncer.reset();
    expect(notifications.toasts).toHaveLength(1);
    expect(notifications.toasts[0].message).toBe("Commit created");
  });
});
