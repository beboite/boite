import { describe, expect, it } from "vitest";
import { declaredTurn, turnIsActive } from "./claude-registry";
import type { LiveClaudeSession } from "$lib/backend/types";

// Kept in step with `turn_tests` in boite-core/src/session.rs: the desktop and
// the server read the same registry and must not disagree about a thread.
function entry(
  id: string,
  status: string,
  cwd: string,
  waitingFor?: string,
): LiveClaudeSession {
  return { id, kind: "interactive", status, cwd, waitingFor };
}

describe("declaredTurn", () => {
  it("reads a captured id off its own entry", () => {
    const live = [entry("a", "busy", "/w/one"), entry("b", "idle", "/w/two")];
    expect(declaredTurn(live, "a", "/w/one")).toEqual({ state: "busy" });
    expect(declaredTurn(live, "b", "/w/two")).toEqual({ state: "idle" });
  });

  it("keeps each of claude's four states apart", () => {
    // Collapsing waiting or shell into idle is what let a thread be called
    // finished while a permission prompt sat unanswered, or while a shell it
    // started still ran.
    const live = [
      entry("busy", "busy", "/w/1"),
      entry("waiting", "waiting", "/w/2", "dialog open"),
      entry("shell", "shell", "/w/3"),
      entry("idle", "idle", "/w/4"),
    ];
    expect(declaredTurn(live, "busy", "")).toEqual({ state: "busy" });
    expect(declaredTurn(live, "waiting", "")).toEqual({
      state: "waiting",
      waitingFor: "dialog open",
    });
    expect(declaredTurn(live, "shell", "")).toEqual({ state: "shell" });
    expect(declaredTurn(live, "idle", "")).toEqual({ state: "idle" });
  });

  it("carries a waiting state with no reason attached", () => {
    const live = [entry("a", "waiting", "/w/one")];
    expect(declaredTurn(live, "a", "/w/one")).toEqual({
      state: "waiting",
      waitingFor: null,
    });
  });

  it("never borrows a neighbour for an id that is not live", () => {
    // The thread's claude has gone, or predates the registry. Answering from the
    // directory here would hand it whoever else is working in there.
    expect(declaredTurn([entry("a", "busy", "/w/one")], "gone", "/w/one")).toBeNull();
  });

  it("places an uncaptured thread by its directory", () => {
    // Those seconds are part of the agent's opening turn, which is where a long
    // subagent run would otherwise read as finished.
    const live = [entry("a", "busy", "/w/one")];
    expect(declaredTurn(live, null, "/w/one")).toEqual({ state: "busy" });
    expect(declaredTurn(live, "", "/w/one")).toEqual({ state: "busy" });
  });

  it("matches directories across separator and case", () => {
    const live = [entry("a", "busy", "C:\\Work\\One\\")];
    expect(declaredTurn(live, null, "c:/work/one")).toEqual({ state: "busy" });
  });

  it("answers nothing when two sessions share a directory", () => {
    const live = [entry("a", "busy", "/w/one"), entry("b", "idle", "/w/one")];
    expect(declaredTurn(live, null, "/w/one")).toBeNull();
  });

  it("answers nothing for a thread it cannot place", () => {
    const live = [entry("a", "busy", "/w/one")];
    expect(declaredTurn(live, null, "/w/other")).toBeNull();
    expect(declaredTurn(live, null, null)).toBeNull();
    expect(declaredTurn([], null, "/w/one")).toBeNull();
    // A session with no recorded cwd cannot be placed by one.
    expect(declaredTurn([entry("a", "busy", "")], null, "/w/one")).toBeNull();
  });

  it("treats an unrecognised status as a turn in flight", () => {
    // Calling a status we cannot read "finished" is what lets auto-sleep kill a
    // working PTY.
    const live = [entry("a", "starting", "/w/one"), entry("b", "", "/w/two")];
    expect(declaredTurn(live, "a", "/w/one")).toEqual({ state: "busy" });
    expect(declaredTurn(live, "b", "/w/two")).toEqual({ state: "busy" });
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
