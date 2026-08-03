import { describe, expect, it } from "vitest";
import {
  formatBytes,
  isReclaimable,
  reclaimable,
  reclaimableBytes,
} from "./worktree-flush";
import type { WorktreeEntry } from "$lib/backend/types";

function entry(over: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    path: "/w/one",
    branch: null,
    head: "abc1234",
    main: false,
    locked: false,
    prunable: false,
    dirty: false,
    orphanCommits: false,
    spare: false,
    ...over,
  };
}

const NOBODY: ReadonlySet<string> = new Set();

describe("isReclaimable", () => {
  it("takes an empty worktree nobody is standing in", () => {
    expect(isReclaimable(entry(), NOBODY)).toBe(true);
  });

  it("never takes the repository's own checkout", () => {
    expect(isReclaimable(entry({ main: true }), NOBODY)).toBe(false);
  });

  it("refuses anything holding work", () => {
    expect(isReclaimable(entry({ dirty: true }), NOBODY)).toBe(false);
    expect(isReclaimable(entry({ orphanCommits: true }), NOBODY)).toBe(false);
  });

  it("refuses a directory a thread is running in", () => {
    // Empty right now, and the agent in it is one command away from filling it.
    expect(isReclaimable(entry(), new Set(["/w/one"]))).toBe(false);
  });

  it("takes a spare and a directory git has already lost", () => {
    expect(isReclaimable(entry({ spare: true }), NOBODY)).toBe(true);
    expect(isReclaimable(entry({ prunable: true }), NOBODY)).toBe(true);
  });
});

describe("reclaimableBytes", () => {
  it("adds up only what was measured", () => {
    const list = reclaimable(
      [entry({ path: "/w/a" }), entry({ path: "/w/b" }), entry({ main: true })],
      NOBODY,
    );
    expect(list).toHaveLength(2);
    expect(reclaimableBytes(list, { "/w/a": 1000, "/w/b": 500 })).toBe(1500);
    // A directory whose size never came back counts as nothing rather than
    // making the button promise space it cannot prove is there.
    expect(reclaimableBytes(list, { "/w/a": 1000 })).toBe(1000);
  });
});

describe("formatBytes", () => {
  it("reads as something on a button", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(940)).toBe("940 B");
    expect(formatBytes(1500)).toBe("1.5 kB");
    expect(formatBytes(2_400_000_000)).toBe("2.4 GB");
    expect(formatBytes(120_000_000_000)).toBe("120 GB");
  });

  it("never reports negative or nonsense space", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});
