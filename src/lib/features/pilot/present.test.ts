import { describe, expect, it } from "vitest";
import {
  caretOn,
  drawable,
  hasBody,
  jumpVisible,
  runState,
  toolKind,
  toolSummary,
} from "./present";
import type { PilotItemRow } from "./types";

function row(over: Partial<PilotItemRow>): PilotItemRow {
  return {
    id: "i1",
    threadId: "t1",
    seq: 1,
    turnId: "turn1",
    kind: "assistant_text",
    state: "completed",
    body: null,
    createdMs: 0,
    updatedMs: 0,
    ...over,
  };
}

describe("hasBody", () => {
  // The defect this exists for: the first version of the pane drew a bordered
  // bar of surface colour with nothing in it between two real cards.
  it("refuses a text row carrying nothing", () => {
    expect(hasBody(row({ body: null }))).toBe(false);
    expect(hasBody(row({ body: { text: "" } }))).toBe(false);
    expect(hasBody(row({ body: { text: "\n  \n" } }))).toBe(false);
    expect(hasBody(row({ kind: "user_message", body: { text: " " } }))).toBe(false);
  });

  it("keeps a text row that says something", () => {
    expect(hasBody(row({ body: { text: "ok" } }))).toBe(true);
  });

  it("keeps a tool call named only by its output", () => {
    expect(hasBody(row({ kind: "tool_call", body: { output: "done" } }))).toBe(true);
    expect(hasBody(row({ kind: "tool_call", body: {} }))).toBe(false);
  });

  it("refuses a file change with no path", () => {
    expect(hasBody(row({ kind: "file_change", body: { summary: "x" } }))).toBe(false);
    expect(hasBody(row({ kind: "file_change", body: { file_path: "a.ts" } }))).toBe(true);
  });

  it("always draws a request and a turn footer", () => {
    expect(hasBody(row({ kind: "request", body: null }))).toBe(true);
    expect(hasBody(row({ kind: "turn", state: "running", body: null }))).toBe(true);
  });

  it("filters a list without touching its order", () => {
    const kept = drawable([
      row({ id: "a", body: { text: "one" } }),
      row({ id: "b", body: { text: "" } }),
      row({ id: "c", body: { text: "two" } }),
    ]);
    expect(kept.map((r) => r.id)).toEqual(["a", "c"]);
  });
});

describe("toolKind", () => {
  it("reads the family off the name", () => {
    expect(toolKind("Bash")).toBe("bash");
    expect(toolKind("Read")).toBe("read");
    expect(toolKind("Write")).toBe("write");
    expect(toolKind("MultiEdit")).toBe("edit");
    expect(toolKind("Grep")).toBe("search");
    expect(toolKind("Fetch")).toBe("read");
    // A name no family claims still gets a card, with the neutral icon.
    expect(toolKind("mcp__boite__whereami")).toBe("other");
    expect(toolKind("WebFetch")).toBe("other");
  });
});

describe("toolSummary", () => {
  it("is the command for a shell call", () => {
    expect(toolSummary({ name: "Bash", input: { command: "git status" } })).toBe("git status");
  });

  it("is the path for a file call", () => {
    expect(toolSummary({ name: "Read", input: { file_path: "src/app.css" } })).toBe(
      "src/app.css",
    );
  });

  it("flattens a command written over several lines", () => {
    expect(toolSummary({ input: { command: "git add .\n  && git commit" } })).toBe(
      "git add . && git commit",
    );
  });

  it("falls back to the JSON when the shape is unknown", () => {
    expect(toolSummary({ input: { weird: 1 } })).toBe('{"weird":1}');
  });

  it("says nothing when there is nothing", () => {
    expect(toolSummary(null)).toBe("");
    expect(toolSummary({})).toBe("");
  });

  it("clamps a long command rather than letting CSS decide", () => {
    const long = "echo " + "x".repeat(300);
    expect(toolSummary({ input: { command: long } }).length).toBe(160);
  });
});

describe("runState", () => {
  it("reads running, done, denied and failed apart", () => {
    expect(runState(row({ kind: "tool_call", state: "started" }))).toBe("running");
    expect(runState(row({ kind: "tool_call", state: "completed" }))).toBe("done");
    expect(runState(row({ kind: "tool_call", body: { outcome: "denied" } }))).toBe("denied");
    expect(runState(row({ kind: "tool_call", body: { is_error: true } }))).toBe("failed");
  });
});

describe("caretOn", () => {
  it("marks the growing row of a running turn", () => {
    expect(caretOn(row({ state: "started" }), true)).toBe(true);
  });

  // A reload lands rows in `started` that nothing will ever complete; a caret
  // on those blinks at a conversation that ended yesterday.
  it("never marks a row while the thread is idle", () => {
    expect(caretOn(row({ state: "started" }), false)).toBe(false);
  });

  it("never marks a finished row, or a tool call", () => {
    expect(caretOn(row({ state: "completed" }), true)).toBe(false);
    expect(caretOn(row({ kind: "tool_call", state: "started" }), true)).toBe(false);
  });
});

describe("jumpVisible", () => {
  it("is up only when the reader left the bottom of a thread worth returning to", () => {
    expect(jumpVisible(true, 40)).toBe(false);
    expect(jumpVisible(false, 40)).toBe(true);
    expect(jumpVisible(false, 1)).toBe(false);
    expect(jumpVisible(false, 0)).toBe(false);
  });
});
