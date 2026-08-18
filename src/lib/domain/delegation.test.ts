import { describe, expect, it } from "vitest";
import {
  delegationOutcome,
  isDelegated,
  shouldCloseDelegation,
} from "./delegation";
import type { ThreadStatus } from "$lib/types";

describe("isDelegated", () => {
  it("is a delegation when the mode says so", () => {
    expect(isDelegated({ delegationMode: "delegation", parentThreadId: null })).toBe(true);
  });

  it("is a delegation when it still names a parent", () => {
    expect(isDelegated({ delegationMode: "normal", parentThreadId: "p" })).toBe(true);
  });

  it("is not a delegation when both are empty", () => {
    expect(isDelegated({ delegationMode: "normal", parentThreadId: null })).toBe(false);
    expect(isDelegated({})).toBe(false);
  });
});

describe("delegationOutcome", () => {
  it("keeps a live agent on screen, including ready between turns", () => {
    const live: ThreadStatus[] = ["running", "waiting", "ready"];
    for (const status of live) {
      expect(delegationOutcome(status, null), status).toBe("running");
    }
  });

  it("does not treat auto-sleep as finished work", () => {
    expect(delegationOutcome("stopped", null)).toBeNull();
    expect(delegationOutcome("idle", null)).toBeNull();
  });

  it("closes a process that ended cleanly", () => {
    expect(delegationOutcome("done", 0)).toBe("completed");
    expect(delegationOutcome("exited", 0)).toBe("completed");
    expect(delegationOutcome("exited", null)).toBe("completed");
  });

  it("keeps a failed process so the parent can see it", () => {
    expect(delegationOutcome("error", null)).toBe("failed");
    expect(delegationOutcome("exited", 1)).toBe("failed");
  });
});

describe("shouldCloseDelegation", () => {
  it("closes only a completed run", () => {
    expect(shouldCloseDelegation("completed")).toBe(true);
    expect(shouldCloseDelegation("failed")).toBe(false);
    expect(shouldCloseDelegation("running")).toBe(false);
    expect(shouldCloseDelegation(null)).toBe(false);
  });
});
