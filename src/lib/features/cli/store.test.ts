import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliJob, CliRow } from "$lib/backend/types";

// The store reaches the transport, the logger, the presence probe and the PTY
// installer at module scope. None of them has anything to say about the job
// bookkeeping this file is about.
const cli = {
  catalog: vi.fn(),
  jobs: vi.fn(),
  dataPaths: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  cancel: vi.fn(),
  dismiss: vi.fn(),
};
const transport = { cli };
// Which boite `backend()` answers as. A switch is a different object, and the
// store compares by identity, so this is what a workspace switch looks like.
const active = { transport: transport as { cli: typeof cli } };

vi.mock("$lib/backend", () => ({ backend: () => active.transport }));
vi.mock("$lib/shared/services/logger.svelte", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("$lib/features/settings/cliDetection.svelte", () => ({
  cliDetection: { refreshOne: vi.fn(), ensure: vi.fn(), refreshAll: vi.fn() },
}));
vi.mock("$lib/features/plugin/installer.svelte", () => ({
  makeInstaller: (plugin: string) => ({ plugin, busy: false, lines: [] }),
}));

const { cliManager, settled } = await import("./store.svelte");
const { cliDetection } = await import("$lib/features/settings/cliDetection.svelte");

const row = (over: Partial<CliRow> = {}): CliRow => ({
  id: "claude",
  exe: "claude",
  installed: false,
  path: null,
  managed: false,
  version: null,
  source: "download",
  installable: true,
  requires: null,
  requiresPresent: null,
  installCommand: null,
  updateCommand: null,
  uninstallCommand: null,
  dataPaths: [],
  ...over,
});

const job = (over: Partial<CliJob> = {}): CliJob => ({
  id: "claude",
  kind: "install",
  phase: "downloading",
  received: 0,
  total: null,
  version: null,
  message: null,
  startedAt: 1,
  updatedAt: 1,
  ...over,
});

/** Lets the poll timer fire and its answer settle. */
const tick = () => new Promise((r) => setTimeout(r, 600));

beforeEach(() => {
  for (const fn of Object.values(cli)) fn.mockReset();
  (cliDetection.refreshOne as ReturnType<typeof vi.fn>).mockReset();
  cli.catalog.mockResolvedValue([row()]);
  cli.jobs.mockResolvedValue([]);
  cliManager.rows = [];
  cliManager.jobs = {};
});

describe("what counts as finished", () => {
  it("reads the three terminal phases and nothing else", () => {
    expect(settled(job({ phase: "downloading" }))).toBe(false);
    expect(settled(job({ phase: "resolving" }))).toBe(false);
    expect(settled(job({ phase: "done" }))).toBe(true);
    expect(settled(job({ phase: "failed" }))).toBe(true);
    expect(settled(job({ phase: "cancelled" }))).toBe(true);
    // No job is not a job in progress: the row's buttons follow this.
    expect(settled(null)).toBe(true);
  });
});

describe("a running job", () => {
  it("is polled until it settles, and the presence probe is asked once at the end", async () => {
    cli.install.mockResolvedValue(job({ phase: "resolving" }));
    cli.catalog.mockResolvedValue([row({ installed: true, managed: true, version: "2.1.0" })]);
    await cliManager.refresh(true);
    await cliManager.install("claude");
    expect(cliManager.busy).toBe(true);

    cli.jobs.mockResolvedValue([job({ phase: "done", version: "2.1.0" })]);
    await tick();

    expect(cliManager.busy).toBe(false);
    expect(cliManager.jobFor("claude")?.phase).toBe("done");
    // The shortcut rows read the PATH from the detection store, not from here.
    expect(cliDetection.refreshOne).toHaveBeenCalledWith("claude");

    const calls = cli.jobs.mock.calls.length;
    await tick();
    expect(cli.jobs.mock.calls.length, "a settled job is still being polled").toBe(calls);
  });

  it("keeps its verdict after Rust has forgotten it", async () => {
    cli.install.mockResolvedValue(job({ phase: "installing" }));
    await cliManager.refresh(true);
    await cliManager.install("claude");
    cli.jobs.mockResolvedValue([job({ phase: "failed", message: "nothing published" })]);
    await tick();

    // Rust ages settled jobs out of its table; the panel is usually the reason
    // the verdict is still on screen.
    cli.jobs.mockResolvedValue([]);
    await tick();
    expect(cliManager.jobFor("claude")?.message).toBe("nothing published");
  });
});

describe("a call that never reached the machine", () => {
  it("leaves a failed job carrying the refusal", async () => {
    await cliManager.refresh(true);
    cli.install.mockRejectedValue("claude has no build for this platform");
    await cliManager.install("claude");
    const failed = cliManager.jobFor("claude");
    expect(failed?.phase).toBe("failed");
    expect(failed?.message).toContain("no build");
    expect(cliManager.busy).toBe(false);
  });

  it("is forgotten on both sides when it is dismissed", async () => {
    await cliManager.refresh(true);
    cli.install.mockRejectedValue("no");
    await cliManager.install("claude");
    cli.dismiss.mockResolvedValue(undefined);
    await cliManager.dismiss("claude");
    expect(cliManager.jobFor("claude")).toBeNull();
    expect(cli.dismiss).toHaveBeenCalledWith("claude");
  });
});

describe("the terminal installer", () => {
  it("exists only for a CLI that ships on a package manager, and is kept", async () => {
    expect(cliManager.installerFor(row({ source: "download" }))).toBeNull();
    expect(cliManager.installerFor(row({ source: "manual" }))).toBeNull();

    const copilot = row({ id: "copilot", exe: "gh", source: "managed", requires: "gh" });
    const first = cliManager.installerFor(copilot);
    expect(first).not.toBeNull();
    // One per CLI: a second instance would attach to the first one's process and
    // draw its log under both rows.
    expect(cliManager.installerFor(copilot)).toBe(first);
  });
});

describe("an answer from a boite that is no longer on screen", () => {
  it("is dropped, and does not clear a flag it no longer owns", async () => {
    // A list is one machine's: these rows say what resolves on the boite that was
    // asked, and drawing them under another one draws the wrong PATH. What makes
    // an answer late is a newer sweep for a different boite, which is what a
    // workspace switch starts.
    let answerFirst: (rows: CliRow[]) => void = () => {};
    cli.catalog.mockImplementationOnce(() => new Promise<CliRow[]>((r) => (answerFirst = r)));
    const first = cliManager.refresh(true);

    const second = { ...cli, catalog: vi.fn().mockResolvedValue([row({ id: "codex", exe: "codex" })]) };
    active.transport = { cli: second as typeof cli };
    await cliManager.refresh(true);
    expect(cliManager.rows.map((r) => r.id)).toEqual(["codex"]);
    expect(cliManager.loading).toBe(false);

    answerFirst([row({ id: "claude", installed: true })]);
    await first;
    expect(cliManager.rows.map((r) => r.id), "the first boite's answer landed late").toEqual([
      "codex",
    ]);
    expect(cliManager.loading, "a late sweep cleared the flag it no longer owns").toBe(false);

    active.transport = transport;
  });
});
