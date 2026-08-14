import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceHit } from "$lib/backend/types";

// The store reaches the transports and the logger at module scope. Neither has
// anything to say about the ordering rules this file is about.
vi.mock("$lib/backend", () => ({
  backend: () => ({ search: { query: async () => [] } }),
  workspace: { isDynamic: false, remoteBackend: null, backendFor: () => null },
}));
vi.mock("$lib/shared/services/logger.svelte", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const { PaletteSearch } = await import("./search.svelte");
const { MIN_SEARCH_LENGTH } = await import("./content");

const hit = (excerpt: string): WorkspaceHit => ({
  kind: "todo",
  projectId: "p",
  refId: excerpt,
  excerpt,
});

/** Lets the debounce timer fire and the answer settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** An `ask` whose answers are resolved by hand, one deferred per call. */
function controllable() {
  const pending: { text: string; resolve: (h: WorkspaceHit[]) => void; reject: (e: unknown) => void }[] = [];
  const ask = (text: string) =>
    new Promise<WorkspaceHit[]>((resolve, reject) => {
      pending.push({ text, resolve, reject });
    });
  return { ask, pending };
}

let logger: { error: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  logger = (await import("$lib/shared/services/logger.svelte")).logger as never;
  logger.error.mockClear();
});

describe("what is worth asking about", () => {
  it("sends nothing for a query below the minimum length", async () => {
    const { ask, pending } = controllable();
    const search = new PaletteSearch(ask, 0);
    search.query("w".repeat(MIN_SEARCH_LENGTH - 1));
    await settle();
    expect(pending).toHaveLength(0);
  });

  it("sends one query for a burst of keystrokes", async () => {
    const { ask, pending } = controllable();
    const search = new PaletteSearch(ask, 5);
    search.query("wo");
    search.query("wor");
    search.query("work");
    await new Promise((r) => setTimeout(r, 20));
    expect(pending.map((p) => p.text)).toEqual(["work"]);
  });

  it("asks nothing again for text it has already asked about", async () => {
    const { ask, pending } = controllable();
    const search = new PaletteSearch(ask, 0);
    search.query("worktree");
    await settle();
    search.query("worktree");
    await settle();
    expect(pending).toHaveLength(1);
  });

  it("trims, so a trailing space is not a new query", async () => {
    const { ask, pending } = controllable();
    const search = new PaletteSearch(ask, 0);
    search.query("worktree");
    await settle();
    search.query("worktree ");
    await settle();
    expect(pending).toHaveLength(1);
  });
});

describe("an answer that arrives out of order", () => {
  /**
   * The rail this exists for: a slow query for the short text landing after a
   * fast one for the long text would put the wrong hits under what is typed.
   */
  it("never overwrites a newer one", async () => {
    const { ask, pending } = controllable();
    const search = new PaletteSearch(ask, 0);

    search.query("wo");
    await settle();
    search.query("worktree");
    await settle();
    expect(pending.map((p) => p.text)).toEqual(["wo", "worktree"]);

    pending[1].resolve([hit("the newer answer")]);
    await settle();
    pending[0].resolve([hit("the older answer")]);
    await settle();

    expect(search.hits.map((h) => h.excerpt)).toEqual(["the newer answer"]);
  });

  it("lands when it is the newest, whatever order it was sent in", async () => {
    const { ask, pending } = controllable();
    const search = new PaletteSearch(ask, 0);

    search.query("wo");
    await settle();
    search.query("worktree");
    await settle();

    pending[0].resolve([hit("the older answer")]);
    await settle();
    expect(search.hits.map((h) => h.excerpt)).toEqual(["the older answer"]);

    pending[1].resolve([hit("the newer answer")]);
    await settle();
    expect(search.hits.map((h) => h.excerpt)).toEqual(["the newer answer"]);
  });

  it("lands on nothing once the palette has cleared", async () => {
    const { ask, pending } = controllable();
    const search = new PaletteSearch(ask, 0);
    search.query("worktree");
    await settle();

    search.clear();
    pending[0].resolve([hit("too late")]);
    await settle();
    expect(search.hits).toEqual([]);
  });

  it("takes the hits away rather than leaving an older query's on screen", async () => {
    const { ask, pending } = controllable();
    const search = new PaletteSearch(ask, 0);

    search.query("wo");
    await settle();
    pending[0].resolve([hit("something")]);
    await settle();
    expect(search.hits).toHaveLength(1);

    search.query("worktree");
    await settle();
    pending[1].reject(new Error("the boite went away"));
    await settle();
    expect(search.hits).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });

  /** A failure for a query that is already superseded says nothing and changes
      nothing: the newer answer is what is on screen. */
  it("ignores a failure that is already stale", async () => {
    const { ask, pending } = controllable();
    const search = new PaletteSearch(ask, 0);

    search.query("wo");
    await settle();
    search.query("worktree");
    await settle();

    pending[1].resolve([hit("the newer answer")]);
    await settle();
    pending[0].reject(new Error("late failure"));
    await settle();

    expect(search.hits.map((h) => h.excerpt)).toEqual(["the newer answer"]);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("dropping below the minimum", () => {
  it("cancels a query that has not gone out yet", async () => {
    const { ask, pending } = controllable();
    const search = new PaletteSearch(ask, 5);
    search.query("worktree");
    search.query("w");
    await new Promise((r) => setTimeout(r, 20));
    expect(pending).toHaveLength(0);
  });

  it("clears what is on screen", async () => {
    const { ask, pending } = controllable();
    const search = new PaletteSearch(ask, 0);
    search.query("worktree");
    await settle();
    pending[0].resolve([hit("something")]);
    await settle();
    expect(search.hits).toHaveLength(1);

    search.query("");
    expect(search.hits).toEqual([]);
  });
});

describe("the answer itself", () => {
  it("is capped and deduplicated on the way in", async () => {
    const { ask, pending } = controllable();
    const search = new PaletteSearch(ask, 0);
    search.query("worktree");
    await settle();
    pending[0].resolve(Array.from({ length: 40 }, () => hit("the same line")));
    await settle();
    expect(search.hits).toHaveLength(1);
  });
});
