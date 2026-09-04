/**
 * Which runtime answers for a scope, decided in the two places that decide it.
 *
 * `orchestratorChatLaunch` is the start: whether the orchestrator about to be
 * created is a chat thread at all. `pilotThreadIdFor` is every read after that:
 * whether the card draws the timeline or the message list. Both are pure enough
 * to test without a window, which is the whole reason they are functions rather
 * than expressions inside a component.
 */

import { describe, expect, it, vi } from "vitest";
import type { PilotCatalog } from "$lib/features/pilot/types";
import type { Thread } from "$lib/types";

const app = { threads: [] as Thread[] };

vi.mock("$lib/app/store.svelte", () => ({ app }));
vi.mock("$lib/backend/active.svelte", () => ({ backend: () => ({ conduct: null }) }));
vi.mock("$lib/features/settings/store.svelte", () => ({
  settings: { state: {} },
  parseCommand: (line: string) => {
    const [cmd, ...args] = line.split(" ");
    return { cmd, args };
  },
}));
vi.mock("$lib/features/settings/orchestratorEnabledFor", () => ({
  orchestratorEnabledFor: () => true,
}));

const { orchestratorChatLaunch } = await import("./api");
const { orchestrator } = await import("./store.svelte");

const catalog: PilotCatalog = {
  drivers: [{ id: "claude", capabilities: {}, models: ["opus"] }],
  instances: [],
} as unknown as PilotCatalog;

function row(over: Partial<Thread>): Thread {
  return {
    id: "t",
    projectId: "p",
    label: "l",
    cmd: "claude",
    args: [],
    createdAt: 0,
    status: "idle",
    runtime: "terminal",
    role: "orchestrator",
    orchestratorScope: null,
    settledAt: null,
    ...over,
  } as unknown as Thread;
}

describe("the orchestrator's runtime at start", () => {
  const both = { catalog, workspace: true, pilot: true };

  it("is a chat thread for an agent this build has a driver for", () => {
    expect(orchestratorChatLaunch({ cmd: "claude", args: [], ...both })).toEqual({
      driver: "claude",
      instance: { type: "native" },
      model: null,
      mode: "ask",
    });
  });

  it("reads a fastpick route by its harness, which is what names the wire", () => {
    const launch = orchestratorChatLaunch({
      cmd: "fastpick",
      args: ["--harness", "claude-code", "--provider", "crof", "--model", "opus", "--"],
      ...both,
    });
    expect(launch?.driver).toBe("claude");
    expect(launch?.instance).toEqual({ type: "fastpick", provider: "crof", model: "opus" });
  });

  it("stays a terminal with either experiment off, or with no driver", () => {
    expect(
      orchestratorChatLaunch({ cmd: "claude", args: [], catalog, workspace: false, pilot: true }),
    ).toBeNull();
    expect(
      orchestratorChatLaunch({ cmd: "claude", args: [], catalog, workspace: true, pilot: false }),
    ).toBeNull();
    // A driver this build does not talk to: the catalog is the answer, never a
    // list written beside it.
    expect(orchestratorChatLaunch({ cmd: "codex", args: [], ...both })).toBeNull();
    expect(orchestratorChatLaunch({ cmd: "", args: [], ...both })).toBeNull();
  });
});

describe("which conversation the home card draws", () => {
  it("names the chat thread answering for a scope, and only that one", () => {
    app.threads = [
      row({ id: "boss", runtime: "pilot" }),
      row({ id: "qboss", runtime: "terminal", orchestratorScope: "q" }),
      row({ id: "worker", runtime: "pilot", role: null }),
    ];
    expect(orchestrator.pilotThreadIdFor(null)).toBe("boss");
    // A terminal orchestrator keeps the message list it always had.
    expect(orchestrator.pilotThreadIdFor("q")).toBeNull();
    // And a scope with no orchestrator at all is the same answer.
    expect(orchestrator.pilotThreadIdFor("nothing")).toBeNull();
  });

  it("forgets a settled holder rather than drawing its timeline", () => {
    app.threads = [row({ id: "boss", runtime: "pilot", settledAt: 5 })];
    expect(orchestrator.pilotThreadIdFor(null)).toBeNull();
  });
});
