import { describe, expect, it } from "vitest";
import { readingOrder } from "./order";
import type { PilotItemRow } from "./types";

function row(
  id: string,
  kind: PilotItemRow["kind"],
  turnId: string | null,
  seq: number,
): PilotItemRow {
  return {
    id,
    threadId: "t",
    seq,
    turnId,
    kind,
    state: "completed",
    body: null,
    createdMs: seq,
    updatedMs: seq,
  };
}

describe("readingOrder", () => {
  // The bug the first live run showed: `turn.started` mints the turn row, so
  // the footer saying what the turn cost was drawn above the answer.
  it("puts the turn footer under the last item of its turn", () => {
    const items = [
      row("turn:a", "turn", "a", 1),
      row("text", "assistant_text", "a", 2),
      row("request:1", "request", "a", 3),
    ];
    expect(readingOrder(items).map((r) => r.id)).toEqual([
      "text",
      "request:1",
      "turn:a",
    ]);
  });

  it("keeps two turns apart", () => {
    const items = [
      row("turn:a", "turn", "a", 1),
      row("one", "assistant_text", "a", 2),
      row("turn:b", "turn", "b", 3),
      row("two", "assistant_text", "b", 4),
    ];
    expect(readingOrder(items).map((r) => r.id)).toEqual([
      "one",
      "turn:a",
      "two",
      "turn:b",
    ]);
  });

  // A turn that has produced nothing yet is what draws the "running" line under
  // a prompt just sent, so it must not disappear.
  it("keeps a turn with nothing under it", () => {
    const items = [row("turn:a", "turn", "a", 1)];
    expect(readingOrder(items).map((r) => r.id)).toEqual(["turn:a"]);
  });

  // The host writes the user's own line as `<turn>#user` before the prompt goes
  // out, so it is the first item of its turn and the running footer belongs
  // under it. Drawn the other way round the user's message would appear to
  // answer the turn it opened.
  it("keeps the user's own message above the footer of the turn it opened", () => {
    const items = [
      row("a#user", "user_message", "a", 1),
      row("turn:a", "turn", "a", 2),
      row("text", "assistant_text", "a", 3),
    ];
    expect(readingOrder(items).map((r) => r.id)).toEqual(["a#user", "text", "turn:a"]);
  });

  // Nothing has answered yet, and the footer is the "running" line. Under the
  // message, never above it and never as a card of its own between two turns.
  it("puts the running footer under a message nothing has answered yet", () => {
    const items = [row("a#user", "user_message", "a", 1), row("turn:a", "turn", "a", 2)];
    expect(readingOrder(items).map((r) => r.id)).toEqual(["a#user", "turn:a"]);
  });

  // The whole point of the reordering: a turn row is only ever drawn as the
  // footer of its own turn, so it can never come out before an item naming it.
  it("never emits a turn row before an item of that turn", () => {
    const items = [
      row("turn:a", "turn", "a", 1),
      row("a#user", "user_message", "a", 2),
      row("text", "assistant_text", "a", 3),
      row("turn:b", "turn", "b", 4),
      row("b#user", "user_message", "b", 5),
    ];
    const ordered = readingOrder(items);
    for (const [at, r] of ordered.entries()) {
      if (r.kind !== "turn") continue;
      const turnId = r.turnId ?? "";
      const after = ordered.slice(at + 1).filter((other) => other.turnId === turnId);
      expect(after.filter((other) => other.kind !== "turn")).toEqual([]);
    }
  });

  it("leaves a timeline with no turn rows exactly as it was", () => {
    const items = [row("a", "notice", null, 1), row("b", "assistant_text", null, 2)];
    expect(readingOrder(items)).toEqual(items);
  });

  it("leaves an item that names no turn where the journal put it", () => {
    const items = [
      row("notice", "notice", null, 1),
      row("turn:a", "turn", "a", 2),
      row("text", "assistant_text", "a", 3),
    ];
    expect(readingOrder(items).map((r) => r.id)).toEqual(["notice", "text", "turn:a"]);
  });
});
