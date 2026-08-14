import { describe, expect, it } from "vitest";
import { filterSidebar, threadMatches } from "./sidebar-filter";

const P = [
  { id: "web", name: "web-app" },
  { id: "api", name: "billing-api" },
];

const THREADS: Record<string, { id: string; label: string; title: string | null }[]> = {
  web: [
    { id: "w1", label: "Claude #1", title: "migrate the router" },
    { id: "w2", label: "Codex #1", title: null },
  ],
  api: [{ id: "a1", label: "Claude #1", title: "invoice rounding" }],
};

const run = (term: string) =>
  filterSidebar(
    P,
    (id) => THREADS[id] ?? [],
    (p) => p.name,
    term,
  );

describe("filtering the sidebar", () => {
  it("changes nothing on an empty term", () => {
    const out = run("   ");
    expect(out.projects.map((p) => p.id)).toEqual(["web", "api"]);
    expect(out.threads.get("web")?.length).toBe(2);
  });

  it("keeps the order it was given", () => {
    const out = run("claude");
    expect(out.projects.map((p) => p.id)).toEqual(["web", "api"]);
  });

  it("drops a project nothing in it matches", () => {
    const out = run("invoice");
    expect(out.projects.map((p) => p.id)).toEqual(["api"]);
    expect(out.threads.get("api")?.map((t) => t.id)).toEqual(["a1"]);
  });

  /**
   * Typing a project name is asking for the project. Hiding its threads at the
   * same time answers a question nobody asked.
   */
  it("keeps every thread of a project matched by name", () => {
    const out = run("web-app");
    expect(out.projects.map((p) => p.id)).toEqual(["web"]);
    expect(out.threads.get("web")?.map((t) => t.id)).toEqual(["w1", "w2"]);
  });

  it("matches a thread on either of its names", () => {
    expect(run("router").threads.get("web")?.map((t) => t.id)).toEqual(["w1"]);
    expect(run("codex").threads.get("web")?.map((t) => t.id)).toEqual(["w2"]);
  });

  it("ignores case and surrounding space", () => {
    expect(run("  ROUTER ").threads.get("web")?.map((t) => t.id)).toEqual(["w1"]);
  });

  it("answers nothing when nothing matches", () => {
    expect(run("zzz").projects).toEqual([]);
  });

  /**
   * Substring, not the palette's fuzzy match. Every row here is already on
   * screen and the user is removing rows, so a hit on scattered letters leaves
   * things in the list with no visible reason for being there.
   */
  it("does not match scattered letters", () => {
    const thread = { id: "x", label: "Claude #1", title: "migrate the router" };
    expect(threadMatches(thread, "mtr")).toBe(false);
    expect(threadMatches(thread, "migrate")).toBe(true);
  });
});
