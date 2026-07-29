import { describe, expect, it } from "vitest";
import { declaredTurn } from "./claude-registry";
import type { LiveClaudeSession } from "$lib/backend/types";

// Kept in step with `turn_tests` in boite-core/src/session.rs: the desktop and
// the server read the same registry and must not disagree about a thread.
function entry(id: string, status: string, cwd: string): LiveClaudeSession {
  return { id, kind: "interactive", status, cwd };
}

describe("declaredTurn", () => {
  it("reads a captured id off its own entry", () => {
    const live = [entry("a", "busy", "/w/one"), entry("b", "idle", "/w/two")];
    expect(declaredTurn(live, "a", "/w/one")).toBe("busy");
    expect(declaredTurn(live, "b", "/w/two")).toBe("idle");
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
    expect(declaredTurn(live, null, "/w/one")).toBe("busy");
    expect(declaredTurn(live, "", "/w/one")).toBe("busy");
  });

  it("matches directories across separator and case", () => {
    const live = [entry("a", "busy", "C:\\Work\\One\\")];
    expect(declaredTurn(live, null, "c:/work/one")).toBe("busy");
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
    expect(declaredTurn(live, "a", "/w/one")).toBe("busy");
    expect(declaredTurn(live, "b", "/w/two")).toBe("busy");
  });
});
