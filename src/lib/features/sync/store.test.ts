import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Backend, SyncConflict, SyncJob, SyncStatus } from "$lib/backend";

/**
 * A fake transport, swapped under the store the way a workspace switch swaps a
 * real one. `backend()` is mocked rather than the whole module, so the store is
 * exercised exactly as it ships.
 */
let active: Backend;

vi.mock("$lib/backend", () => ({
  backend: () => active,
}));

const settingsState = { syncOnLaunch: true, syncRemoteUrl: "git@example.invalid:me/config.git" };

vi.mock("$lib/features/settings/store.svelte", () => ({
  settings: {
    get state() {
      return settingsState;
    },
  },
}));

const { syncStore } = await import("./store.svelte");

function job(overrides: Partial<SyncJob> = {}): SyncJob {
  return {
    phase: "idle",
    supported: true,
    filesRead: 0,
    filesTotal: null,
    path: null,
    message: null,
    pushedSha: null,
    lastSyncedAt: null,
    pending: 0,
    startedAt: 0,
    updatedAt: 0,
    notes: {
      skippedLinks: [],
      throughLink: [],
      notText: [],
      denied: [],
      rulesSkipped: [],
      unreadable: [],
    },
    needed: [],
    refused: [],
    backupDir: null,
    ...overrides,
  };
}

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    supported: true,
    remoteUrl: "git@example.invalid:me/config.git",
    branch: "main",
    hasBase: false,
    job: job(),
    ...overrides,
  };
}

function conflict(path: string): SyncConflict {
  return {
    path,
    sourceId: "agents",
    base: null,
    local: "# mine\n",
    remote: "# theirs\n",
    binary: false,
  };
}

/** A transport whose every call can be watched and made to fail. */
function transport(overrides: Partial<Backend["sync"]> = {}): Backend {
  const sync: Backend["sync"] = {
    sources: vi.fn(async () => [
      { id: "agents", paths: [".agents"], supported: true, presentHere: true },
    ]),
    status: vi.fn(async () => status()),
    probe: vi.fn(async () => ({ reachable: true, empty: false, needsAuth: false, message: null })),
    pull: vi.fn(async () => [] as SyncConflict[]),
    conflicts: vi.fn(async () => [] as SyncConflict[]),
    resolve: vi.fn(async () => job()),
    skip: vi.fn(async () => job()),
    push: vi.fn(async () => job()),
    cancel: vi.fn(async () => true),
    dismiss: vi.fn(async () => {}),
    repair: vi.fn(async () => {}),
    ...overrides,
  };
  return { sync } as unknown as Backend;
}

beforeEach(() => {
  syncStore.forget();
  settingsState.syncOnLaunch = true;
  settingsState.syncRemoteUrl = "git@example.invalid:me/config.git";
  active = transport();
});

describe("loading", () => {
  it("does not fetch again for the same transport once it has the rows", async () => {
    await syncStore.refresh();
    const before = (active.sync.sources as ReturnType<typeof vi.fn>).mock.calls.length;
    await syncStore.ensure();
    expect((active.sync.sources as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });

  it("reports a transport that will not answer, in place", async () => {
    active = transport({
      status: vi.fn(async () => {
        throw new Error("the remote refused");
      }),
    });
    await syncStore.refresh();
    expect(syncStore.error).toBe("the remote refused");
    expect(syncStore.status).toBeNull();
  });
});

describe("the transport that answered", () => {
  // A workspace switch mid-call would otherwise land another machine's answer,
  // and another machine's ~/.claude, in this panel.
  it("drops an answer from a transport that is no longer on screen", async () => {
    let release: (value: SyncStatus) => void = () => {};
    const slow = transport({
      status: vi.fn(
        () =>
          new Promise<SyncStatus>((resolve) => {
            release = resolve;
          }),
      ),
    });
    active = slow;
    const pending = syncStore.refresh();

    active = transport();
    await syncStore.refresh();
    const after = syncStore.status;

    release(status({ branch: "from-the-other-machine" }));
    await pending;
    expect(syncStore.status).toBe(after);
    expect(syncStore.status?.branch).toBe("main");
  });

  it("forgets everything when the workspace changes", async () => {
    await syncStore.refresh();
    syncStore.openMerge("agents/.agents/AGENTS.md");
    syncStore.forget();
    expect(syncStore.sources).toEqual([]);
    expect(syncStore.status).toBeNull();
    expect(syncStore.mergeOpen).toBe(false);
  });
});

describe("the launch pull", () => {
  it("sends nothing and opens the merge tool when something differs", async () => {
    active = transport({ pull: vi.fn(async () => [conflict("agents/.agents/AGENTS.md")]) });
    await syncStore.pullAtLaunch();
    expect(active.sync.push).not.toHaveBeenCalled();
    expect(syncStore.mergeOpen).toBe(true);
    expect(syncStore.activePath).toBe("agents/.agents/AGENTS.md");
  });

  it("happens once per transport, and again for a new one", async () => {
    await syncStore.pullAtLaunch();
    await syncStore.pullAtLaunch();
    expect((active.sync.pull as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    const grafted = transport();
    active = grafted;
    await syncStore.pullAtLaunch();
    expect((grafted.sync.pull as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("does nothing when the switch is off or no repository is named", async () => {
    settingsState.syncOnLaunch = false;
    await syncStore.pullAtLaunch();
    expect(active.sync.pull).not.toHaveBeenCalled();

    settingsState.syncOnLaunch = true;
    settingsState.syncRemoteUrl = null;
    await syncStore.pullAtLaunch();
    expect(active.sync.pull).not.toHaveBeenCalled();
  });

  // An app that opens on an error dialogue because the wifi is off is worse
  // than one that says so in the settings panel.
  it("says so in place rather than interrupting, when the repository is unreachable", async () => {
    active = transport({
      pull: vi.fn(async () => {
        throw new Error("could not read from remote repository");
      }),
    });
    await syncStore.pullAtLaunch();
    expect(syncStore.mergeOpen).toBe(false);
    expect(syncStore.error).toContain("could not read");
  });
});

describe("settling files", () => {
  beforeEach(async () => {
    active = transport({
      pull: vi.fn(async () => [
        conflict("agents/.agents/AGENTS.md"),
        conflict("agents/.agents/skills/one/SKILL.md"),
      ]),
    });
    await syncStore.syncNow();
  });

  it("moves to the next file that is still waiting", async () => {
    await syncStore.resolve("agents/.agents/AGENTS.md", "# both\n");
    expect(syncStore.verdicts["agents/.agents/AGENTS.md"]).toBe("resolved");
    expect(syncStore.activePath).toBe("agents/.agents/skills/one/SKILL.md");
    expect(syncStore.mergeOpen).toBe(true);
  });

  it("closes the tool once nothing is waiting", async () => {
    await syncStore.resolve("agents/.agents/AGENTS.md", "# both\n");
    await syncStore.skip("agents/.agents/skills/one/SKILL.md");
    expect(syncStore.pending).toBe(0);
    expect(syncStore.mergeOpen).toBe(false);
  });

  // The safe-to-abandon invariant: one file failing is not the run failing, and
  // the rest are still there to decide.
  it("marks one failure without touching the others", async () => {
    active = transport({
      resolve: vi.fn(async () => {
        throw new Error("what is here is not text");
      }),
    });
    await syncStore.resolve("agents/.agents/AGENTS.md", "# both\n");
    expect(syncStore.verdicts["agents/.agents/AGENTS.md"]).toBe("failed");
    expect(syncStore.verdicts["agents/.agents/skills/one/SKILL.md"]).toBeUndefined();
    expect(syncStore.pending).toBe(1);
  });

  // Nothing is rolled back: rolling back an applied file would be the overwrite
  // this feature does not do, in the other direction.
  it("keeps what was already applied when the tool is closed half way", async () => {
    await syncStore.resolve("agents/.agents/AGENTS.md", "# both\n");
    syncStore.closeMerge();
    expect(syncStore.mergeOpen).toBe(false);
    expect(syncStore.verdicts["agents/.agents/AGENTS.md"]).toBe("resolved");
    expect(syncStore.pending).toBe(1);
  });
});

describe("busy", () => {
  it("is true only while something is actually running", async () => {
    for (const phase of ["fetching", "comparing", "pushing"] as const) {
      active = transport({ status: vi.fn(async () => status({ job: job({ phase }) })) });
      await syncStore.refresh();
      expect(syncStore.busy, phase).toBe(true);
    }
    // needsMerge is settled and is not a failure: it is the user's turn.
    for (const phase of ["idle", "done", "needsMerge", "failed", "cancelled"] as const) {
      active = transport({ status: vi.fn(async () => status({ job: job({ phase }) })) });
      await syncStore.refresh();
      expect(syncStore.busy, phase).toBe(false);
    }
  });
});
