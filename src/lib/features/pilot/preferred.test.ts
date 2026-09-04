import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: { experimentPilot: true },
  terminal: vi.fn(), chat: vi.fn(), ensure: vi.fn(), choice: vi.fn(), error: vi.fn(),
}));
vi.mock("$lib/features/settings/store.svelte", async (importOriginal) => ({
  ...await importOriginal<typeof import("$lib/features/settings/store.svelte")>(),
  settings: { state: mocks.state },
}));
vi.mock("$lib/features/thread/api", () => ({ launchChat: mocks.chat, launchShortcut: mocks.terminal }));
vi.mock("./catalog.svelte", () => ({ pilotCatalog: { ensure: mocks.ensure }, chatChoice: mocks.choice }));
vi.mock("$lib/features/notifications/store.svelte", () => ({ notifications: { error: mocks.error } }));
vi.mock("$lib/i18n/index.svelte", () => ({ t: (key: string) => key }));
import { launchPreferredShortcut } from "./preferred";

const shortcut = (command: string) => ({ id: "shortcut", label: command, command, iconKey: "terminal" as const });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.state.experimentPilot = true;
  mocks.choice.mockReturnValue({ offered: true, enabled: true });
});

describe("primary launcher", () => {
  it.each(["codex", "claude", "pwsh -NoLogo -Command claude", "opencode"])("opens %s as a chat", async (command) => {
    await launchPreferredShortcut(shortcut(command), "project");
    expect(mocks.ensure).toHaveBeenCalledOnce();
    expect(mocks.chat).toHaveBeenCalledWith(shortcut(command), "project");
    expect(mocks.terminal).not.toHaveBeenCalled();
  });
  it("preserves arbitrary shell commands", async () => {
    await launchPreferredShortcut(shortcut("bun test"), "project");
    expect(mocks.terminal).toHaveBeenCalledOnce();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("respects an explicit opt-out", async () => {
    mocks.state.experimentPilot = false;
    await launchPreferredShortcut(shortcut("codex"), "project");
    expect(mocks.terminal).toHaveBeenCalledOnce();
    expect(mocks.chat).not.toHaveBeenCalled();
  });
  it("waits for the catalog before choosing", async () => {
    let done = () => {};
    mocks.ensure.mockReturnValue(new Promise<void>((resolve) => { done = resolve; }));
    const launch = launchPreferredShortcut(shortcut("codex"), "project");
    expect(mocks.chat).not.toHaveBeenCalled();
    expect(mocks.terminal).not.toHaveBeenCalled();
    done();
    await launch;
    expect(mocks.chat).toHaveBeenCalledOnce();
  });
  it("reports an unavailable driver without silently opening a terminal", async () => {
    mocks.choice.mockReturnValue({ offered: true, enabled: false });
    await launchPreferredShortcut(shortcut("codex"), "project");
    expect(mocks.error).toHaveBeenCalledWith("pilot.noDriver");
    expect(mocks.terminal).not.toHaveBeenCalled();
    expect(mocks.chat).not.toHaveBeenCalled();
  });
});
