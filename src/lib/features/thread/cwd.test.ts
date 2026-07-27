import { describe, expect, it } from "vitest";

import { threadCwd, threadGitRoot } from "./cwd";

const project = { cwd: "D:/repo", gitRoot: null };

describe("threadCwd", () => {
  it("is the project folder for a thread that has no worktree", () => {
    expect(threadCwd({ worktreePath: null }, project)).toBe("D:/repo");
    expect(threadCwd({ worktreePath: undefined }, project)).toBe("D:/repo");
  });

  it("is the worktree when the thread has one", () => {
    expect(threadCwd({ worktreePath: "D:/repo/.wt/a1f0" }, project)).toBe("D:/repo/.wt/a1f0");
  });

  it("has no answer when there is no project", () => {
    expect(threadCwd({ worktreePath: null }, null)).toBeNull();
  });

  // Threads restored from before the column existed carry no field at all.
  it("survives a thread that predates the column", () => {
    expect(threadCwd({}, project)).toBe("D:/repo");
  });
});

describe("threadGitRoot", () => {
  it("falls back to the project folder when nothing else is set", () => {
    expect(threadGitRoot({ worktreePath: null }, project)).toBe("D:/repo");
  });

  it("uses the nested repo the user picked", () => {
    const nested = { cwd: "D:/parent", gitRoot: "D:/parent/api" };
    expect(threadGitRoot({ worktreePath: null }, nested)).toBe("D:/parent/api");
  });

  // A worktree is already a repository, so the "the folder is not a repo, look
  // one level down" answer does not apply to it.
  it("lets the worktree win over the nested repo", () => {
    const nested = { cwd: "D:/parent", gitRoot: "D:/parent/api" };
    expect(threadGitRoot({ worktreePath: "D:/wt/a1f0" }, nested)).toBe("D:/wt/a1f0");
  });
});
