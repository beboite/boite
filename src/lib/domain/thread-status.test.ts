import { describe, expect, it } from "vitest";
import type { ThreadStatus } from "$lib/types";
import {
  hasNoProcess,
  isDurable,
  isFinished,
  isParked,
} from "./thread-status";

const ALL: ThreadStatus[] = [
  "idle",
  "running",
  "ready",
  "waiting",
  "done",
  "exited",
  "error",
  "stopped",
];

describe("thread status", () => {
  it("counts stopped as finished", () => {
    // The whole reason this module exists. One of the seven hand-written
    // copies tested three statuses instead of four, on the remote path, so a
    // slept thread kept a ptyId the server had already reaped.
    expect(isFinished("stopped")).toBe(true);
    expect(ALL.filter(isFinished)).toEqual(["done", "exited", "error", "stopped"]);
  });

  it("keeps running and ready out of every finished set", () => {
    for (const status of ["running", "ready", "waiting"] as ThreadStatus[]) {
      expect(isFinished(status)).toBe(false);
      expect(hasNoProcess(status)).toBe(false);
      expect(isDurable(status)).toBe(false);
    }
  });

  it("treats idle as having no process without calling it finished", () => {
    expect(isFinished("idle")).toBe(false);
    expect(hasNoProcess("idle")).toBe(true);
  });

  it("parks only what can be relaunched without it having failed", () => {
    expect(ALL.filter(isParked)).toEqual(["idle", "stopped"]);
  });

  it("persists exactly what stays true across a restart", () => {
    expect(ALL.filter(isDurable)).toEqual([
      "idle",
      "done",
      "exited",
      "error",
      "stopped",
    ]);
  });
});
