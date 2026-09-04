import { describe, expect, it } from "vitest";
import { emptyState, fromRows, openRequests, reduce, turnDiff } from "./reduce";
import type { PilotEvent, PilotItemRow } from "./types";

function row(over: Partial<PilotItemRow> & Pick<PilotItemRow, "id" | "seq">): PilotItemRow {
  return {
    threadId: "t1",
    turnId: null,
    kind: "assistant_text",
    state: "completed",
    body: null,
    createdMs: 0,
    updatedMs: 0,
    ...over,
  };
}

function run(events: PilotEvent[]) {
  const state = emptyState();
  for (const event of events) reduce(state, event);
  return state;
}

describe("the pilot reduction", () => {
  it("takes the native session and the model off the start of a session", () => {
    const state = run([
      {
        kind: "session.started",
        native_session_id: "native-1",
        model: "claude-fable-5-1",
        slash_commands: ["init"],
      },
    ]);
    expect(state.nativeSessionId).toBe("native-1");
    expect(state.model).toBe("claude-fable-5-1");
  });

  it("writes one turn row for the two edges, not one per edge", () => {
    const state = run([
      { kind: "turn.started", turn_id: "turn-1" },
      {
        kind: "turn.completed",
        turn_id: "turn-1",
        duration_ms: 42,
        usage: {
          input_tokens: 7,
          output_tokens: 4,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ]);
    const turns = state.items.filter((item) => item.kind === "turn");
    expect(turns).toHaveLength(1);
    expect(turns[0].state).toBe("completed");
    expect(turns[0].body?.durationMs).toBe(42);
    expect(state.usage?.input_tokens).toBe(7);
    expect(state.status).toBe("idle");
  });

  it("keeps the diff the start edge wrote when the end edge completes the turn", () => {
    const state = fromRows([
      row({
        id: "turn:turn-1",
        seq: 1,
        kind: "turn",
        state: "running",
        turnId: "turn-1",
        body: { turnId: "turn-1", checkpointStart: "abc" },
      }),
    ]);
    reduce(state, {
      kind: "turn.completed",
      turn_id: "turn-1",
      duration_ms: 1,
    });
    expect(state.items[0].body?.checkpointStart).toBe("abc");
  });

  it("reads a turn's diff back off its row", () => {
    const state = fromRows([
      row({
        id: "turn:turn-1",
        seq: 1,
        kind: "turn",
        state: "completed",
        turnId: "turn-1",
        body: { diff: { files: 2, additions: 9, deletions: 1, fileList: [] } },
      }),
    ]);
    expect(turnDiff(state, "turn-1")?.additions).toBe(9);
    expect(turnDiff(state, "turn-2")).toBeNull();
  });

  it("appends deltas to the item they name and nowhere else", () => {
    const state = run([
      { kind: "item.started", item: { id: "i1", kind: "assistant_text", turn_id: "turn-1" } },
      { kind: "item.started", item: { id: "i2", kind: "reasoning", turn_id: "turn-1" } },
      { kind: "item.delta", item_id: "i1", text: "o" },
      { kind: "item.delta", item_id: "i1", text: "k" },
      { kind: "item.delta", item_id: "i2", text: "hm" },
    ]);
    expect(state.items[0].body?.text).toBe("ok");
    expect(state.items[1].body?.text).toBe("hm");
  });

  it("drops a delta for an item nothing opened", () => {
    const state = emptyState();
    expect(reduce(state, { kind: "item.delta", item_id: "ghost", text: "x" })).toBe(false);
    expect(state.items).toHaveLength(0);
  });

  it("completes an empty item with what its deltas carried", () => {
    const state = run([
      { kind: "item.started", item: { id: "i1", kind: "assistant_text" } },
      { kind: "item.delta", item_id: "i1", text: "ok" },
      { kind: "item.completed", item: { id: "i1", kind: "assistant_text" } },
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0].state).toBe("completed");
    expect(state.items[0].body?.text).toBe("ok");
  });

  it("opens a request, waits on it, and closes the one card when it is answered", () => {
    const state = run([
      { kind: "turn.started", turn_id: "turn-1" },
      {
        kind: "request.opened",
        request: {
          id: "r1",
          kind: "tool_approval",
          tool_name: "Bash",
          options: [{ value: "allow", label: "Allow" }],
        },
      },
    ]);
    expect(state.status).toBe("waiting");
    expect(state.requests).toHaveLength(1);
    const cards = state.items.filter((item) => item.kind === "request");
    expect(cards).toHaveLength(1);

    reduce(state, { kind: "request.resolved", request_id: "r1", outcome: "allowed" });
    // Marked rather than dropped: the dock draws its card out of this list and
    // the approvals row it is mounted on closes a moment later.
    expect(openRequests(state)).toHaveLength(0);
    expect(state.requests.map((request) => request.outcome)).toEqual(["allowed"]);
    expect(state.status).toBe("busy");
    expect(state.items.filter((item) => item.kind === "request")).toHaveLength(1);
    expect(state.items.find((item) => item.kind === "request")?.state).toBe("allowed");
  });

  it("keeps waiting while a second question is still up", () => {
    const state = run([
      { kind: "request.opened", request: { id: "r1", kind: "tool_approval" } },
      { kind: "request.opened", request: { id: "r2", kind: "question" } },
      { kind: "request.resolved", request_id: "r1", outcome: "allowed" },
    ]);
    expect(state.status).toBe("waiting");
    expect(openRequests(state).map((request) => request.id)).toEqual(["r2"]);
  });

  it("takes a session that went as the end of every open question", () => {
    const state = run([
      { kind: "request.opened", request: { id: "r1", kind: "tool_approval" } },
      { kind: "session.exited", reason: { reason: "stopped" } },
    ]);
    expect(state.requests).toHaveLength(0);
    expect(openRequests(state)).toHaveLength(0);
    expect(state.status).toBe("idle");
  });

  it("records a status only when it moved", () => {
    const state = emptyState();
    expect(reduce(state, { kind: "status.changed", status: "busy" })).toBe(true);
    expect(reduce(state, { kind: "status.changed", status: "busy" })).toBe(false);
    expect(state.status).toBe("busy");
  });

  it("records the model and the usage the driver reports", () => {
    const state = run([
      { kind: "model.changed", model: "sonnet" },
      {
        kind: "usage.updated",
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          context_window: 200000,
        },
      },
    ]);
    expect(state.model).toBe("sonnet");
    expect(state.usage?.context_window).toBe(200000);
  });

  it("puts an error on the timeline with the turn it belongs to", () => {
    const state = run([{ kind: "error", message: "the agent protocol broke", turn_id: "turn-1" }]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0].kind).toBe("error");
    expect(state.items[0].turnId).toBe("turn-1");
  });

  it("resumes mid-turn: the stored rows keep their place and the live events finish them", () => {
    const state = fromRows([
      row({ id: "turn:turn-1", seq: 1, kind: "turn", state: "running", turnId: "turn-1" }),
      row({ id: "i1", seq: 2, state: "started", body: { text: "half" }, turnId: "turn-1" }),
    ]);
    expect(state.cursor).toBe(2);

    reduce(state, { kind: "item.delta", item_id: "i1", text: " done" });
    reduce(state, { kind: "item.completed", item: { id: "i1", kind: "assistant_text" } });
    reduce(state, { kind: "turn.completed", turn_id: "turn-1", duration_ms: 5 });

    expect(state.items).toHaveLength(2);
    expect(state.items[0].kind).toBe("turn");
    expect(state.items[0].state).toBe("completed");
    expect(state.items[1].body?.text).toBe("half done");
  });

  it("rebuilds the open questions off the rows, with what the driver asked", () => {
    const state = fromRows([
      row({
        id: "request:r1",
        seq: 1,
        kind: "request",
        state: "open",
        body: {
          id: "r1",
          kind: "tool_approval",
          tool_name: "Bash",
          input: { command: "git status" },
          options: [
            { value: "allow", label: "Allow" },
            { value: "deny", label: "Deny" },
          ],
        },
      }),
    ]);
    // The card the dock is drawing survives the reload that dropped it: it
    // looks its request id up here and has nothing else to draw from.
    expect(state.requests).toHaveLength(1);
    const request = state.requests[0];
    expect(request.id).toBe("r1");
    expect(request.tool_name).toBe("Bash");
    expect(request.input).toEqual({ command: "git status" });
    expect(request.options?.map((option) => option.value)).toEqual(["allow", "deny"]);
    expect(request.outcome).toBeNull();
    expect(openRequests(state)).toHaveLength(1);
  });

  it("rebuilds an answered question too, outcome and all", () => {
    const state = fromRows([
      row({
        id: "request:r1",
        seq: 1,
        kind: "request",
        state: "allowed",
        body: {
          id: "r1",
          requestId: "r1",
          kind: "tool_approval",
          tool_name: "Bash",
          outcome: "allowed",
          options: [{ value: "allow", label: "Allow" }],
        },
      }),
    ]);
    expect(state.requests.map((request) => request.outcome)).toEqual(["allowed"]);
    expect(state.requests[0].tool_name).toBe("Bash");
    expect(openRequests(state)).toHaveLength(0);
  });

  it("answers a question that was only ever read back off the rows", () => {
    const state = fromRows([
      row({
        id: "request:r1",
        seq: 1,
        kind: "request",
        state: "open",
        body: { id: "r1", kind: "tool_approval", tool_name: "Bash" },
      }),
    ]);
    reduce(state, { kind: "request.resolved", request_id: "r1", outcome: "denied" });
    expect(state.requests[0].outcome).toBe("denied");
    expect(openRequests(state)).toHaveLength(0);
    expect(state.items.filter((item) => item.kind === "request")).toHaveLength(1);
  });

  it("a completed card keeps the position it opened at", () => {
    const state = run([
      { kind: "item.started", item: { id: "i1", kind: "assistant_text" } },
      { kind: "item.started", item: { id: "i2", kind: "tool_call" } },
      { kind: "item.completed", item: { id: "i1", kind: "assistant_text", body: { text: "a" } } },
    ]);
    expect(state.items.map((item) => item.id)).toEqual(["i1", "i2"]);
  });
});
