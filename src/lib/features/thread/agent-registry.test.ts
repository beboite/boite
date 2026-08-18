import { describe, expect, it } from "vitest";
import { declaredTurn, turnIsActive } from "./agent-registry";
import type { AgentTurn } from "$lib/backend/types";

// Kept in step with `turn_tests` in boite-core/src/session.rs: the desktop and
// the server read the same stores and must not disagree about a thread.
function turn(
  kind: string,
  id: string,
  state: string,
  cwd: string,
  waitingFor?: string,
): AgentTurn {
  return { kind, sessionId: id, state, cwd, waitingFor };
}

const claude = (id: string, state: string, cwd: string, waitingFor?: string) =>
  turn("claude", id, state, cwd, waitingFor);

describe("declaredTurn", () => {
  it("reads a captured id off its own entry", () => {
    const live = [claude("a", "busy", "/w/one"), claude("b", "idle", "/w/two")];
    expect(declaredTurn(live, "claude", "a", "/w/one")).toEqual({ state: "busy" });
    expect(declaredTurn(live, "claude", "b", "/w/two")).toEqual({ state: "idle" });
  });

  it("keeps each declared state apart", () => {
    // Collapsing waiting or shell into idle is what let a thread be called
    // finished while a permission prompt sat unanswered, or while a shell it
    // started still ran.
    const live = [
      claude("busy", "busy", "/w/1"),
      claude("waiting", "waiting", "/w/2", "dialog open"),
      claude("shell", "shell", "/w/3"),
      claude("idle", "idle", "/w/4"),
    ];
    expect(declaredTurn(live, "claude", "busy", "")).toEqual({ state: "busy" });
    expect(declaredTurn(live, "claude", "waiting", "")).toEqual({
      state: "waiting",
      waitingFor: "dialog open",
    });
    expect(declaredTurn(live, "claude", "shell", "")).toEqual({ state: "shell" });
    expect(declaredTurn(live, "claude", "idle", "")).toEqual({ state: "idle" });
  });

  it("carries a waiting state with no reason attached", () => {
    const live = [claude("a", "waiting", "/w/one")];
    expect(declaredTurn(live, "claude", "a", "/w/one")).toEqual({
      state: "waiting",
      waitingFor: null,
    });
  });

  it("never hands one agent another agent's answer", () => {
    // Two agents in one directory is ordinary, and both may be mid-turn. The kind
    // is checked before the id and before the directory, so neither an id
    // collision nor a shared folder can cross the wires.
    const live = [
      claude("shared", "busy", "/w/one"),
      turn("codex", "shared", "idle", "/w/one"),
      turn("opencode", "oc", "busy", "/w/two"),
      turn("grok", "g", "busy", "/w/one"),
    ];
    expect(declaredTurn(live, "claude", "shared", "/w/one")).toEqual({ state: "busy" });
    expect(declaredTurn(live, "codex", "shared", "/w/one")).toEqual({ state: "idle" });
    expect(declaredTurn(live, "grok", "g", "/w/one")).toEqual({ state: "busy" });
    // By directory, each agent sees exactly one candidate rather than two.
    expect(declaredTurn(live, "claude", null, "/w/one")).toEqual({ state: "busy" });
    expect(declaredTurn(live, "codex", null, "/w/one")).toEqual({ state: "idle" });
    // An agent nobody reported on stays unanswered rather than borrowing.
    expect(declaredTurn(live, "opencode", null, "/w/one")).toBeNull();
    expect(declaredTurn(live, "cursor", null, "/w/two")).toBeNull();
  });

  it("never borrows a neighbour for an id that is not live", () => {
    // The thread's agent has gone, or predates whatever records this. Answering
    // from the directory would hand it whoever else is working in there.
    const live = [claude("a", "busy", "/w/one")];
    expect(declaredTurn(live, "claude", "gone", "/w/one")).toBeNull();
  });

  it("places an uncaptured thread by its directory", () => {
    // Those seconds are part of the agent's opening turn, which is where a long
    // subagent run would otherwise read as finished.
    const live = [claude("a", "busy", "/w/one")];
    expect(declaredTurn(live, "claude", null, "/w/one")).toEqual({ state: "busy" });
    expect(declaredTurn(live, "claude", "", "/w/one")).toEqual({ state: "busy" });
  });

  it("matches directories across separator and case", () => {
    const live = [claude("a", "busy", "C:\\Work\\One\\")];
    expect(declaredTurn(live, "claude", null, "c:/work/one")).toEqual({ state: "busy" });
  });

  it("answers nothing when two sessions of one agent share a directory", () => {
    const live = [claude("a", "busy", "/w/one"), claude("b", "idle", "/w/one")];
    expect(declaredTurn(live, "claude", null, "/w/one")).toBeNull();
  });

  it("answers nothing for a thread it cannot place", () => {
    const live = [claude("a", "busy", "/w/one")];
    expect(declaredTurn(live, "claude", null, "/w/other")).toBeNull();
    expect(declaredTurn(live, "claude", null, null)).toBeNull();
    expect(declaredTurn([], "claude", null, "/w/one")).toBeNull();
    // A session with no recorded cwd cannot be placed by one.
    expect(declaredTurn([claude("a", "busy", "")], "claude", null, "/w/one")).toBeNull();
  });

  it("treats an unrecognised state as a turn in flight", () => {
    // Calling a state we cannot read "finished" is what lets auto-sleep kill a
    // working PTY.
    const live = [claude("a", "starting", "/w/one"), turn("codex", "b", "", "/w/two")];
    expect(declaredTurn(live, "claude", "a", "/w/one")).toEqual({ state: "busy" });
    expect(declaredTurn(live, "codex", "b", "/w/two")).toEqual({ state: "busy" });
  });
});

describe("turnIsActive", () => {
  it("counts everything but a finished turn as active", () => {
    // What auto-sleep reads. Waiting and shell are not the agent thinking, and
    // are not a thread anyone may kill either.
    expect(turnIsActive({ state: "busy" })).toBe(true);
    expect(turnIsActive({ state: "waiting" })).toBe(true);
    expect(turnIsActive({ state: "shell" })).toBe(true);
    expect(turnIsActive({ state: "idle" })).toBe(false);
  });
});
