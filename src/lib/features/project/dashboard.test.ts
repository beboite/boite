import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The overview is opened from three places and drawn by two layouts, and the
 * layouts disagree about what covers what. The store is stubbed down to the
 * four fields this decision touches.
 */
const { app } = vi.hoisted(() => ({
  app: {
    selectedProjectId: null as string | null,
    activeThreadId: null as string | null,
    view: "terminal" as string,
    mobileTab: "terminal" as string,
  },
}));

vi.mock("$lib/app/store.svelte", () => ({ app }));

const { openProjectDashboard } = await import("./dashboard");

describe("openProjectDashboard", () => {
  beforeEach(() => {
    app.selectedProjectId = null;
    app.activeThreadId = "thread-1";
    app.view = "terminal";
    app.mobileTab = "projects";
  });

  it("puts the project's page in front and leaves the thread behind", () => {
    openProjectDashboard("p1");
    expect(app.selectedProjectId).toBe("p1");
    expect(app.activeThreadId).toBeNull();
    expect(app.view).toBe("project");
  });

  // The phone's tab pages are rendered after the view overlays and at the same
  // depth, so `projects` — which is where this used to leave the bottom bar —
  // draws the project list on top of the dashboard it just opened.
  it("leaves the phone on the one tab the dashboard is visible over", () => {
    openProjectDashboard("p1");
    expect(app.mobileTab).toBe("terminal");
  });
});
