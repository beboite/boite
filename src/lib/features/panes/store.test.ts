import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The pane tree is tested in `tree.test.ts`; this is the store on top of it,
 * which is where a pane or a whole group can go missing.
 *
 * `app` is stubbed rather than imported: the real store reaches SQLite, the
 * platform layer and the Tauri event bus on the way in, and none of that has
 * anything to say about whether closing a pane keeps the group.
 */
const { app } = vi.hoisted(() => {
  interface FakeThread {
    id: string;
    projectId: string;
  }
  const store = {
    threads: [] as FakeThread[],
    threadById(id: string | null | undefined): FakeThread | null {
      return store.threads.find((t) => t.id === id) ?? null;
    },
  };
  return { app: store };
});

vi.mock("$lib/app/store.svelte", () => ({ app }));

import { paneStore, countLeaves, leafNodesOf, leavesOf } from "./store.svelte";
import { MAX_LEAVES } from "./types";

function threads(...rows: [string, string][]) {
  app.threads = rows.map(([id, projectId]) => ({ id, projectId }));
  paneStore.syncWithThreads();
}

/** The kinds in one group, in layout order. Reads like the screen does. */
function kindsOf(paneId: string): string[] {
  const g = paneStore.groupOf(paneId);
  if (!g) return [];
  return leafNodesOf(g.root).map((l) => l.content.kind);
}

/**
 * The store persists, and both halves of that leak across tests.
 *
 * `syncWithThreads` hydrates from localStorage once per module lifetime, so
 * whatever a previous file left in the blob would arrive as extra groups in
 * whichever test happens to run first. And `saveSoon` writes on a 250 ms timer,
 * so a test that ends before it fires hands its layout to the next one. Fake
 * timers keep every pending write pending, and dropping them on the way out
 * means nothing here ever reaches the blob at all.
 */
beforeEach(() => {
  vi.useFakeTimers();
  if (typeof localStorage !== "undefined") localStorage.clear();
  paneStore.groups = [];
  paneStore.rects = {};
  paneStore.dropPreview = null;
  app.threads = [];
});

afterEach(() => {
  // Discards the timers still queued, which is the point: none of them belongs
  // to the test about to run.
  vi.useRealTimers();
  if (typeof localStorage !== "undefined") localStorage.clear();
});

describe("syncWithThreads", () => {
  it("gives every thread a group of its own", () => {
    threads(["t1", "p"], ["t2", "p"]);
    expect(paneStore.groups.length).toBe(2);
    expect(paneStore.groupOf("t1")?.focusedPaneId).toBe("t1");
  });

  it("reaps a group whose last thread is gone, panels included", () => {
    threads(["t1", "p"]);
    paneStore.openBeside("t1", { kind: "git" });
    expect(countLeaves(paneStore.groupOf("t1")!.root)).toBe(2);

    threads();
    expect(paneStore.groups).toEqual([]);
  });

  it("keeps the surviving threads of a group that lost one", () => {
    threads(["t1", "p"], ["t2", "p"]);
    paneStore.splitInto("t1", "t2", "right");
    paneStore.openBeside("t1", { kind: "todo" });

    threads(["t1", "p"]);
    const group = paneStore.groupOf("t1")!;
    expect(paneStore.groups.length).toBe(1);
    expect(kindsOf("t1")).toEqual(["thread", "todo"]);
    // Whatever the focus lands on, it is a pane that still exists. It was on
    // the dead thread's neighbour, so it does not have to move at all.
    expect(leavesOf(group.root)).toContain(group.focusedPaneId);
  });

  /**
   * The regression this test exists for: panels used to hang off a rail that
   * drew itself whether or not a terminal was running, and a group holding
   * nothing else was reaped on the next sync as if it had been widowed. On a
   * project nobody has launched anything in, that is every panel there is.
   */
  it("leaves a panel group that never had a thread alone", () => {
    const paneId = paneStore.openGroup("p", { kind: "git" })!;
    expect(paneId).toBeTruthy();

    paneStore.syncWithThreads();
    expect(paneStore.groups.length).toBe(1);

    threads(["t1", "p"]);
    expect(paneStore.groups.length).toBe(2);
    expect(paneStore.groupOf(paneId)).toBeTruthy();
  });

  it("moves the focus off a pane that died under it", () => {
    threads(["t1", "p"], ["t2", "p"]);
    paneStore.splitInto("t1", "t2", "right");
    expect(paneStore.groupOf("t1")?.focusedPaneId).toBe("t2");

    threads(["t1", "p"]);
    expect(paneStore.groupOf("t1")?.focusedPaneId).toBe("t1");
  });

  it("forgets the rects and the drop preview of panes that went away", () => {
    threads(["t1", "p"]);
    paneStore.setRect("t1", { x: 0, y: 0, w: 10, h: 10 });
    paneStore.dropPreview = { targetPaneId: "t1", side: "right", refused: false };

    threads();
    expect(paneStore.rects).toEqual({});
    expect(paneStore.dropPreview).toBe(null);
  });

  it("never gives one thread a second group", () => {
    threads(["t1", "p"]);
    paneStore.syncWithThreads();
    paneStore.syncWithThreads();
    expect(paneStore.groups.length).toBe(1);
  });
});

describe("openBeside", () => {
  it("focuses the copy that is already there instead of opening a second", () => {
    threads(["t1", "p"]);
    const first = paneStore.openBeside("t1", { kind: "git" });
    paneStore.groupOf("t1")!.focusedPaneId = "t1";
    const second = paneStore.openBeside("t1", { kind: "git" });

    expect(second).toBe(first);
    expect(countLeaves(paneStore.groupOf("t1")!.root)).toBe(2);
    expect(paneStore.groupOf("t1")!.focusedPaneId).toBe(first);
  });

  it("tells two browser panes apart by their address", () => {
    threads(["t1", "p"]);
    const a = paneStore.openBeside("t1", { kind: "browser", url: "http://localhost:1/" });
    const b = paneStore.openBeside("t1", { kind: "browser", url: "http://localhost:2/" });
    expect(b).not.toBe(a);
    expect(countLeaves(paneStore.groupOf("t1")!.root)).toBe(3);
  });

  it("refuses past the pane cap rather than splitting forever", () => {
    threads(["t1", "p"]);
    const kinds = ["git", "explorer", "todo"] as const;
    for (const kind of kinds) expect(paneStore.openBeside("t1", { kind })).toBeTruthy();
    expect(countLeaves(paneStore.groupOf("t1")!.root)).toBe(MAX_LEAVES);
    expect(paneStore.openBeside("t1", { kind: "dashboard" })).toBe(null);
  });

  it("refuses a target that is not in any group", () => {
    expect(paneStore.openBeside("nobody", { kind: "git" })).toBe(null);
  });

  it("names a thread pane after its thread and anything else uniquely", () => {
    threads(["t1", "p"], ["t2", "p"]);
    expect(paneStore.openBeside("t1", { kind: "thread", threadId: "t2" })).toBe("t2");
    const panel = paneStore.openBeside("t1", { kind: "editor" })!;
    expect(panel.startsWith("pane-")).toBe(true);
  });
});

describe("openGroup", () => {
  it("seeds a group of one panel for a project with no terminal", () => {
    const paneId = paneStore.openGroup("p", { kind: "explorer" })!;
    expect(paneStore.groups.length).toBe(1);
    expect(paneStore.groups[0].projectId).toBe("p");
    expect(paneStore.groupOf(paneId)?.focusedPaneId).toBe(paneId);
  });

  it("refuses a thread, which is syncWithThreads' job", () => {
    expect(paneStore.openGroup("p", { kind: "thread", threadId: "t1" })).toBe(null);
    expect(paneStore.groups).toEqual([]);
  });
});

describe("closePane", () => {
  it("prunes a panel and moves the focus off it", () => {
    threads(["t1", "p"]);
    const git = paneStore.openBeside("t1", { kind: "git" })!;
    paneStore.setRect(git, { x: 0, y: 0, w: 1, h: 1 });

    expect(paneStore.closePane(git)).toBe(true);
    expect(kindsOf("t1")).toEqual(["thread"]);
    expect(paneStore.groupOf("t1")?.focusedPaneId).toBe("t1");
    expect(paneStore.rects[git]).toBeUndefined();
  });

  it("takes the whole group when the panel was the only thing in it", () => {
    const git = paneStore.openGroup("p", { kind: "git" })!;
    expect(paneStore.closePane(git)).toBe(true);
    expect(paneStore.groups).toEqual([]);
  });

  it("refuses the last thread pane, which the sidebar owns", () => {
    threads(["t1", "p"]);
    expect(paneStore.closePane("t1")).toBe(false);
    expect(paneStore.groups.length).toBe(1);
  });

  it("moves a split thread out rather than killing it", () => {
    threads(["t1", "p"], ["t2", "p"]);
    paneStore.splitInto("t1", "t2", "right");
    expect(countLeaves(paneStore.groupOf("t1")!.root)).toBe(2);

    expect(paneStore.closePane("t2")).toBe(true);
    expect(paneStore.groupOf("t2")).toBeTruthy();
    expect(paneStore.groupOf("t2")?.id).not.toBe(paneStore.groupOf("t1")?.id);
    expect(countLeaves(paneStore.groupOf("t1")!.root)).toBe(1);
  });

  it("refuses a pane nobody has", () => {
    expect(paneStore.closePane("nobody")).toBe(false);
  });
});

describe("splitInto", () => {
  it("moves a thread into another group and takes the empty one with it", () => {
    threads(["t1", "p"], ["t2", "p"]);
    expect(paneStore.splitInto("t1", "t2", "right")).toBe(true);
    expect(paneStore.groups.length).toBe(1);
    expect(leavesOf(paneStore.groupOf("t1")!.root)).toEqual(["t1", "t2"]);
    expect(paneStore.groupOf("t1")?.focusedPaneId).toBe("t2");
  });

  it("takes the panels the moved thread left behind with the group", () => {
    // They were opened next to that terminal and there is nothing under them
    // once it goes.
    threads(["t1", "p"], ["t2", "p"]);
    paneStore.openBeside("t2", { kind: "git" });
    expect(paneStore.groups.length).toBe(2);

    expect(paneStore.splitInto("t1", "t2", "right")).toBe(true);
    expect(paneStore.groups.length).toBe(1);
    expect(kindsOf("t1")).toEqual(["thread", "thread"]);
  });

  it("keeps the source group when a thread is left in it", () => {
    threads(["t1", "p"], ["t2", "p"], ["t3", "p"]);
    paneStore.splitInto("t2", "t3", "right");
    expect(paneStore.splitInto("t1", "t3", "right")).toBe(true);

    expect(paneStore.groups.length).toBe(2);
    expect(leavesOf(paneStore.groupOf("t2")!.root)).toEqual(["t2"]);
    expect(paneStore.groupOf("t2")?.focusedPaneId).toBe("t2");
  });

  it("reorders inside one group without dropping anything", () => {
    threads(["t1", "p"], ["t2", "p"]);
    paneStore.splitInto("t1", "t2", "right");
    expect(paneStore.splitInto("t1", "t2", "left")).toBe(true);
    expect(leavesOf(paneStore.groupOf("t1")!.root)).toEqual(["t2", "t1"]);
    expect(paneStore.groups.length).toBe(1);
  });

  it("refuses a thread from another project", () => {
    threads(["t1", "p"], ["other", "q"]);
    expect(paneStore.splitInto("t1", "other", "right")).toBe(false);
    expect(paneStore.groups.length).toBe(2);
  });

  it("refuses a group that is already full", () => {
    threads(["t1", "p"], ["t2", "p"]);
    for (const kind of ["git", "explorer", "todo"] as const) {
      paneStore.openBeside("t1", { kind });
    }
    expect(paneStore.splitInto("t1", "t2", "right")).toBe(false);
    // And the thread it refused is still where it was.
    expect(paneStore.groupOf("t2")).toBeTruthy();
  });

  it("refuses a thread dropped on itself and one that does not exist", () => {
    threads(["t1", "p"]);
    expect(paneStore.splitInto("t1", "t1", "right")).toBe(false);
    expect(paneStore.splitInto("t1", "ghost", "right")).toBe(false);
  });
});
