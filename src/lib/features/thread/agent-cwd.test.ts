import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/shared/services/logger.svelte", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));

import {
  cwdToRecognize,
  noticeDeclaredCwd,
  resetNoticeCache,
} from "./agent-cwd";
import type { Project, Thread } from "$lib/types";

afterEach(() => {
  resetNoticeCache();
});

describe("cwdToRecognize", () => {
  it("is the declared directory when it is not where the thread already runs", () => {
    expect(cwdToRecognize("D:/repo/.wt/a", "D:/repo", "D:/repo")).toBe("D:/repo/.wt/a");
  });

  it("is nothing when the agent is still in the project folder", () => {
    expect(cwdToRecognize("D:/repo", "D:/repo", "D:/repo")).toBeNull();
    expect(cwdToRecognize("D:\\repo\\", "D:/repo", "D:/repo")).toBeNull();
  });

  it("is nothing when the agent is already in the worktree we opened", () => {
    expect(
      cwdToRecognize("D:/repo/.boite/worktrees/t1", "D:/repo/.boite/worktrees/t1", "D:/repo"),
    ).toBeNull();
  });

  it("is nothing when the agent said nothing", () => {
    expect(cwdToRecognize(null, "D:/repo", "D:/repo")).toBeNull();
    expect(cwdToRecognize("  ", "D:/repo", "D:/repo")).toBeNull();
  });
});

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    projectId: "p",
    label: "Claude",
    cmd: "claude",
    args: [],
    iconKey: "claude",
    status: "running",
    createdAt: 0,
    ...over,
  } as Thread;
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: "p",
    name: "repo",
    cwd: "D:/repo",
    icon: null,
    archived: false,
    ...over,
  };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("noticeDeclaredCwd", () => {
  it("asks once, then persists the worktree the backend recognised", async () => {
    const recognize = vi.fn(async () => "D:/repo/.claude/worktrees/job");
    const persist = vi.fn(async () => {});
    const opts = {
      thread: thread(),
      project: project(),
      declared: "D:/repo/.claude/worktrees/job",
      recognize,
      persist,
    };
    noticeDeclaredCwd(opts);
    noticeDeclaredCwd(opts);
    await settled();
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(recognize).toHaveBeenCalledWith("D:/repo", "D:/repo/.claude/worktrees/job");
    expect(persist).toHaveBeenCalledWith("D:/repo/.claude/worktrees/job");
  });

  it("does not persist when the path is not this repository's worktree", async () => {
    const persist = vi.fn(async () => {});
    noticeDeclaredCwd({
      thread: thread(),
      project: project(),
      declared: "D:/other",
      recognize: async () => null,
      persist,
    });
    await settled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("asks again when persist fails, so a dropped write is not forgotten", async () => {
    const recognize = vi.fn(async () => "D:/repo/.wt/a");
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce(undefined);
    const opts = {
      thread: thread(),
      project: project(),
      declared: "D:/repo/.wt/a",
      recognize,
      persist,
    };
    noticeDeclaredCwd(opts);
    await settled();
    noticeDeclaredCwd(opts);
    await settled();
    expect(recognize).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledTimes(2);
  });
});
