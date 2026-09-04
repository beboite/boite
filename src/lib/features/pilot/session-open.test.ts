import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ open: vi.fn(), error: vi.fn() }));
vi.mock("$lib/backend", () => ({ backend: () => ({ pilot: { open: mocks.open } }) }));
vi.mock("$lib/features/notifications/store.svelte", () => ({ notifications: { error: mocks.error } }));
vi.mock("$lib/shared/services/logger.svelte", () => ({ logger: { warn: vi.fn() } }));
vi.mock("$lib/i18n/index.svelte", () => ({ t: (key: string) => key }));
import { forgetPilotSession, openPilotSession, pilotSessionOpenedHere } from "./session";
import { pilotConnections } from "./connection.svelte";

describe("native session startup", () => {
  it("deduplicates launcher and pane opens", async () => {
    let done = () => {};
    mocks.open.mockReturnValueOnce(new Promise<void>((resolve) => { done = resolve; }));
    const first = openPilotSession("dedup");
    const second = openPilotSession("dedup");
    expect(second).toBe(first);
    expect(pilotConnections.get("dedup")).toBe("opening");
    await Promise.resolve();
    expect(mocks.open).toHaveBeenCalledTimes(1);
    done();
    await first;
    expect(pilotConnections.get("dedup")).toBe("ready");
    forgetPilotSession("dedup");
  });

  it("keeps a failed startup visible and permits retry", async () => {
    mocks.open.mockRejectedValueOnce(new Error("missing engine"));
    await openPilotSession("retry");
    expect(pilotConnections.get("retry")).toBe("failed");
    expect(pilotSessionOpenedHere("retry")).toBe(false);
    mocks.open.mockResolvedValueOnce(undefined);
    await openPilotSession("retry");
    expect(pilotConnections.get("retry")).toBe("ready");
    forgetPilotSession("retry");
  });

  it("does not resurrect startup state after a stop", async () => {
    let done = () => {};
    mocks.open.mockReturnValueOnce(new Promise<void>((resolve) => { done = resolve; }));
    const opening = openPilotSession("stopped");
    forgetPilotSession("stopped");
    done();
    await opening;
    expect(pilotConnections.has("stopped")).toBe(false);
    expect(pilotSessionOpenedHere("stopped")).toBe(false);
  });
});
