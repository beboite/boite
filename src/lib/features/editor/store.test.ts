import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which strip a buffer lands in, which is the difference between a pane that
 * shows the file and a pane that shows "pick a file".
 *
 * The disk decides on its own (`projectOwning`), except for a caller that knows
 * better: an agent's `pane_open kind=editor` puts the pane in its own thread's
 * group, and the strip drawn there shows one project's buffers. A plan written
 * to the scratchpad belongs to no project, or worse to whichever project sits
 * on the home directory, and either way it was filtered out of the pane that
 * was opened to show it.
 *
 * `app` is stubbed down to the two lists `owner.ts` reads. The backend is
 * stubbed at `./api`: nothing here is about reading bytes.
 */
const { app, reads } = vi.hoisted(() => ({
  app: {
    projects: [] as { id: string; cwd: string; gitRoot?: string | null }[],
    threads: [] as { projectId: string; worktreePath: string | null }[],
  },
  reads: [] as string[],
}));

vi.mock("$lib/app/store.svelte", () => ({ app }));
vi.mock("$lib/i18n/index.svelte", () => ({ t: (key: string) => key }));
vi.mock("$lib/shared/services/logger.svelte", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
vi.mock("$lib/features/notifications/store.svelte", () => ({
  notifications: { error: () => {}, info: () => {}, success: () => {} },
}));
vi.mock("$lib/shared/components/confirm.svelte", () => ({
  confirmDialog: { ask: async () => true },
}));
vi.mock("./api", () => ({
  readTextFile: async (path: string) => {
    reads.push(path);
    return { content: "plan", size: 4, isReadonly: false, lossy: false };
  },
  writeTextFile: async () => 0,
  readBase64: async () => "",
  gitFileVersions: async () => ({ head: null, index: null, work: null, binary: false }),
  turnFileVersions: async () => ({ before: null, after: null, binary: false }),
}));

const { editorStore } = await import("./store.svelte");

const SCRATCHPAD =
  "C:/Users/mtsu/AppData/Local/Temp/claude/boite-worktree/scratchpad/plan.md";

beforeEach(() => {
  editorStore.buffers = [];
  editorStore.activeId = null;
  reads.length = 0;
  app.projects = [
    { id: "boite", cwd: "D:/Dev/Collab/boite" },
    // The home directory as a project of its own, which is what makes a
    // scratchpad path land somewhere it has nothing to do with.
    { id: "scratch", cwd: "C:/Users/mtsu" },
  ];
  app.threads = [];
});

describe("which project a buffer is filed under", () => {
  it("takes the caller's word over the path", async () => {
    await editorStore.open(SCRATCHPAD, { owner: "boite" });

    expect(editorStore.forProject("boite").map((b) => b.path)).toEqual([SCRATCHPAD]);
    expect(editorStore.forProject("scratch")).toEqual([]);
  });

  it("falls back to the disk when nobody says", async () => {
    await editorStore.open(SCRATCHPAD);

    expect(editorStore.forProject("scratch").map((b) => b.path)).toEqual([SCRATCHPAD]);
    expect(editorStore.forProject("boite")).toEqual([]);
  });

  it("re-files a buffer already open when another project asks for it", async () => {
    await editorStore.open(SCRATCHPAD);
    await editorStore.open(SCRATCHPAD, { owner: "boite" });

    expect(editorStore.buffers).toHaveLength(1);
    expect(editorStore.forProject("boite").map((b) => b.path)).toEqual([SCRATCHPAD]);
    expect(editorStore.forProject("scratch")).toEqual([]);
  });

  it("leaves a buffer where it is for a caller that names no owner", async () => {
    await editorStore.open("D:/Dev/Collab/boite/README.md", { owner: "scratch" });
    await editorStore.open("D:/Dev/Collab/boite/README.md");

    expect(editorStore.forProject("scratch")).toHaveLength(1);
    expect(editorStore.forProject("boite")).toEqual([]);
  });

  it("files a preview the same way", async () => {
    await editorStore.open(
      "C:/Users/mtsu/AppData/Local/Temp/claude/shot.png",
      { owner: "boite" },
    );

    expect(editorStore.forProject("boite")).toHaveLength(1);
  });
});
