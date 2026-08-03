import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one door everything opens a pane through, so it is also the one place
 * where a pane can fail to appear at all.
 *
 * `app` is stubbed down to the four fields this module reads. The message
 * catalogue is stubbed to hand back the key, because what matters in a refusal
 * is which refusal it was.
 */
const { app, errors } = vi.hoisted(() => {
  interface FakeThread {
    id: string;
    projectId: string;
  }
  const store = {
    threads: [] as FakeThread[],
    activeThreadId: null as string | null,
    selectedProjectId: null as string | null,
    view: "project" as string,
    threadById(id: string | null | undefined): FakeThread | null {
      return store.threads.find((t) => t.id === id) ?? null;
    },
    get currentProjectId(): string | null {
      return (
        store.selectedProjectId ??
        store.threadById(store.activeThreadId)?.projectId ??
        null
      );
    },
  };
  return { app: store, errors: [] as string[] };
});

vi.mock("$lib/app/store.svelte", () => ({ app }));
vi.mock("$lib/i18n/index.svelte", () => ({ t: (key: string) => key }));
vi.mock("$lib/features/notifications/store.svelte", () => ({
  notifications: {
    error: (message: string) => errors.push(message),
    success: () => {},
  },
}));

import {
  anchorPaneId,
  anchorProjectId,
  closePanelPane,
  openPane,
  panePresence,
  panelRatio,
  splitFocused,
} from "./open";
import { paneStore, countLeaves, leafNodesOf } from "./store.svelte";

function threads(...rows: [string, string][]) {
  app.threads = rows.map(([id, projectId]) => ({ id, projectId }));
  paneStore.syncWithThreads();
}

beforeEach(() => {
  paneStore.groups = [];
  paneStore.rects = {};
  paneStore.viewport = null;
  app.threads = [];
  app.activeThreadId = null;
  app.selectedProjectId = null;
  app.view = "project";
  errors.length = 0;
});

describe("openPane", () => {
  it("opens beside the focused pane of the active thread's group", () => {
    threads(["t1", "p"]);
    app.activeThreadId = "t1";

    const paneId = openPane({ kind: "git" });
    expect(paneId).toBeTruthy();
    expect(paneStore.groupOf("t1")?.focusedPaneId).toBe(paneId);
    expect(countLeaves(paneStore.groupOf("t1")!.root)).toBe(2);
  });

  it("brings the terminal view forward, since that is where panes live", () => {
    threads(["t1", "p"]);
    app.activeThreadId = "t1";
    openPane({ kind: "todo" });
    expect(app.view).toBe("terminal");
  });

  /**
   * The regression this exists for: with no thread open there was no anchor,
   * so git, files, todo and the editor were unreachable — the titlebar button
   * and every palette pane command answered with an error. The rail these
   * replaced drew regardless of how many terminals were running.
   */
  it("opens a group of its own when the project has no terminal", () => {
    app.selectedProjectId = "p";
    const paneId = openPane({ kind: "git" });

    expect(paneId).toBeTruthy();
    expect(errors).toEqual([]);
    expect(paneStore.groups.length).toBe(1);
    expect(paneStore.groups[0].projectId).toBe("p");
  });

  it("puts the second panel of a threadless project beside the first", () => {
    app.selectedProjectId = "p";
    openPane({ kind: "git" });
    openPane({ kind: "explorer" });

    expect(paneStore.groups.length).toBe(1);
    expect(leafNodesOf(paneStore.groups[0].root).map((l) => l.content.kind)).toEqual([
      "git",
      "explorer",
    ]);
  });

  it("refuses only when there is no project either", () => {
    expect(openPane({ kind: "git" })).toBe(null);
    expect(errors).toEqual(["panes.needProject"]);
    expect(paneStore.groups).toEqual([]);
  });

  it("says the group is full rather than failing quietly", () => {
    threads(["t1", "p"]);
    app.activeThreadId = "t1";
    for (const kind of ["git", "explorer", "todo"] as const) openPane({ kind });
    expect(errors).toEqual([]);

    expect(openPane({ kind: "dashboard" })).toBe(null);
    expect(errors).toEqual(["panes.groupFull"]);
  });
});

describe("anchorPaneId", () => {
  it("prefers the active thread's group", () => {
    threads(["t1", "p"], ["t2", "p"]);
    app.activeThreadId = "t2";
    expect(anchorPaneId()).toBe("t2");
  });

  /**
   * The regression: the page draws the active thread's group, and with no
   * active thread only the project's panel group — the one with no terminal in
   * it. Anchoring in a thread group instead put the panel in a group nothing
   * renders, so the titlebar button lit up over an unchanged screen.
   */
  it("ignores a thread group of the project while no thread is active", () => {
    threads(["t1", "p"], ["other", "q"]);
    app.selectedProjectId = "q";
    expect(anchorPaneId()).toBe(null);
  });

  it("falls back to the project's own panel group", () => {
    threads(["other", "q"]);
    app.selectedProjectId = "q";
    const paneId = openPane({ kind: "git" });
    expect(paneId).toBeTruthy();
    expect(anchorPaneId()).toBe(paneId);
  });

  it("is null when the project has nothing open", () => {
    app.selectedProjectId = "p";
    expect(anchorPaneId()).toBe(null);
  });
});

describe("anchorProjectId", () => {
  it("answers with the project a pane would land in, not the one selected", () => {
    // What stops an agent in one project from dropping a pane into another:
    // the anchor is whatever is on screen, and that is very often elsewhere.
    threads(["t1", "p"]);
    app.activeThreadId = "t1";
    app.selectedProjectId = "q";
    expect(anchorProjectId()).toBe("p");
  });

  it("falls back to the selected project when nothing is open", () => {
    app.selectedProjectId = "q";
    expect(anchorProjectId()).toBe("q");
  });
});

describe("panePresence and closePanelPane", () => {
  it("closes a detached panel and leaves its neighbour alone", () => {
    threads(["t1", "p"]);
    app.activeThreadId = "t1";

    expect(panePresence("git")).toBe(null);
    openPane({ kind: "git" });
    expect(panePresence("git")).toBeTruthy();
    expect(closePanelPane("git")).toBe(true);
    expect(panePresence("git")).toBe(null);
    expect(countLeaves(paneStore.groupOf("t1")!.root)).toBe(1);
  });

  it("says so when there is no detached panel to close", () => {
    threads(["t1", "p"]);
    app.activeThreadId = "t1";
    // What tells the titlebar button to fall through to the docked column
    // instead of swallowing the click.
    expect(closePanelPane("todo")).toBe(false);
  });

  it("takes the group with it on a project with no terminal", () => {
    app.selectedProjectId = "p";
    openPane({ kind: "explorer" });
    expect(paneStore.groups.length).toBe(1);

    expect(closePanelPane("explorer")).toBe(true);
    expect(paneStore.groups).toEqual([]);
  });

  it("sees only the group it would open into", () => {
    threads(["t1", "p"], ["other", "q"]);
    app.activeThreadId = "other";
    openPane({ kind: "todo" });

    app.activeThreadId = "t1";
    expect(panePresence("todo")).toBe(null);
  });

  /** The editor asks the same question before covering the window with itself. */
  it("answers for the editor, not only the three panels", () => {
    threads(["t1", "p"]);
    app.activeThreadId = "t1";
    expect(panePresence("editor")).toBe(null);
    const paneId = openPane({ kind: "editor" });
    expect(panePresence("editor")).toBe(paneId);
  });
});

describe("panelRatio", () => {
  it("is a column of about 320px, whatever the window is wide", () => {
    paneStore.setViewport(2560, 1400);
    expect(Math.round(panelRatio() * 2560)).toBe(320);
  });

  it("stays a usable share of a narrow window", () => {
    paneStore.setViewport(600, 800);
    expect(panelRatio()).toBeLessThanOrEqual(0.6);
    expect(panelRatio()).toBeGreaterThanOrEqual(0.12);
  });
});

describe("splitFocused", () => {
  it("offers the project overview, since there is nothing obvious to show", () => {
    threads(["t1", "p"]);
    app.activeThreadId = "t1";

    const paneId = splitFocused("bottom");
    expect(paneId).toBeTruthy();
    expect(paneStore.contentOf(paneId!)?.kind).toBe("dashboard");
  });
});
