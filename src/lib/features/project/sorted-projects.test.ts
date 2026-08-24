import { describe, expect, it } from "vitest";
import { SCRATCH_PROJECT_ID } from "$lib/domain/project";
import { isSettled } from "$lib/domain/thread-settle";
import type { Project, Thread } from "$lib/types";

// Pure sort algorithm matching the one in store.svelte.ts
function sortProjects(
  projects: Project[],
  threadsByProject: Map<string, Thread[]>,
  projectOrder: string[] = [],
  smart: { by: "activity" | "alphabetical"; dir: 1 | -1 } | null = null,
  activityOf: (p: Project) => number = () => 0,
): Project[] {
  const idx = new Map(projectOrder.map((id, i) => [id, i]));
  const hasThreads = (p: Project): boolean => {
    const threads = threadsByProject.get(p.id);
    if (!threads || threads.length === 0) return false;
    return threads.some((t) => !isSettled(t));
  };
  return projects
    .filter((p) => !p.archived)
    .sort((a, b) => {
      const as = a.id === SCRATCH_PROJECT_ID ? 1 : 0;
      const bs = b.id === SCRATCH_PROJECT_ID ? 1 : 0;
      if (as !== bs) return as - bs;

      // A project with no threads sinks to the bottom, above Scratch.
      const ae = hasThreads(a) ? 0 : 1;
      const be = hasThreads(b) ? 0 : 1;
      if (ae !== be) return ae - be;

      if (smart) {
        const cmp =
          smart.by === "activity"
            ? (activityOf(a) - activityOf(b)) * smart.dir
            : a.name.localeCompare(b.name) * smart.dir;
        if (cmp !== 0) return cmp;
        return a.name.localeCompare(b.name);
      }
      const ai = idx.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bi = idx.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a.name.localeCompare(b.name);
    });
}

function makeProject(id: string, name: string, archived = false): Project {
  return {
    id,
    name,
    cwd: `/test/${id}`,
    icon: null,
    archived,
    origin: "local",
  };
}

function makeThread(id: string, projectId: string, settledAt?: number | null): Thread {
  return {
    id,
    projectId,
    ptyId: "pty1",
    label: `Thread ${id}`,
    title: null,
    cmd: "bash",
    args: [],
    iconKey: "claude",
    sessionId: null,
    status: "idle",
    exitCode: null,
    createdAt: 0,
    settledAt: settledAt ?? null,
  };
}

describe("project sorting with empty vs active threads", () => {
  it("sinks projects with 0 threads to the bottom above Scratch", () => {
    const p1 = makeProject("p1", "Project 1");
    const p2 = makeProject("p2", "Project 2");
    const p3 = makeProject("p3", "Project 3");
    const scratch = makeProject(SCRATCH_PROJECT_ID, "Scratch");

    const threadsMap = new Map<string, Thread[]>([
      ["p1", [makeThread("t1", "p1")]],
      ["p2", []], // 0 threads
      ["p3", [makeThread("t2", "p3")]],
      [SCRATCH_PROJECT_ID, []],
    ]);

    const result = sortProjects([p1, p2, p3, scratch], threadsMap, ["p1", "p2", "p3"]);
    expect(result.map((p) => p.id)).toEqual(["p1", "p3", "p2", SCRATCH_PROJECT_ID]);
  });

  it("treats projects with only settled/archived threads as having no threads", () => {
    const p1 = makeProject("p1", "Project 1");
    const p2 = makeProject("p2", "Project 2");

    const threadsMap = new Map<string, Thread[]>([
      ["p1", [makeThread("t1", "p1", 1000)]], // settled/archived thread only
      ["p2", [makeThread("t2", "p2")]], // regular live thread
    ]);

    const result = sortProjects([p1, p2], threadsMap, ["p1", "p2"]);
    expect(result.map((p) => p.id)).toEqual(["p2", "p1"]);
  });

  it("moves project back up when an unsettled thread is added", () => {
    const p1 = makeProject("p1", "Project 1");
    const p2 = makeProject("p2", "Project 2");

    const settledMap = new Map<string, Thread[]>([
      ["p1", [makeThread("t1", "p1", 1000)]], // settled
      ["p2", [makeThread("t2", "p2")]],
    ]);
    expect(sortProjects([p1, p2], settledMap, ["p1", "p2"]).map((p) => p.id)).toEqual(["p2", "p1"]);

    const liveMap = new Map<string, Thread[]>([
      ["p1", [makeThread("t1", "p1", null)]], // live
      ["p2", [makeThread("t2", "p2")]],
    ]);
    expect(sortProjects([p1, p2], liveMap, ["p1", "p2"]).map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("filters out archived projects", () => {
    const p1 = makeProject("p1", "Project 1");
    const p2 = makeProject("p2", "Project 2", true); // archived

    const threadsMap = new Map<string, Thread[]>([
      ["p1", [makeThread("t1", "p1")]],
      ["p2", [makeThread("t2", "p2")]],
    ]);

    const result = sortProjects([p1, p2], threadsMap);
    expect(result.map((p) => p.id)).toEqual(["p1"]);
  });
});
