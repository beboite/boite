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
