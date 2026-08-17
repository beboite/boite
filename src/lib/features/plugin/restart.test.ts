import { describe, expect, it } from "vitest";
import { shouldReloadAfterSwitch } from "./restart";

const base = {
  cmd: "claude",
  label: "Claude",
  iconKey: "claude" as const,
  status: "ready" as const,
  sessionId: "s1",
  ptyId: "p1",
};

describe("shouldReloadAfterSwitch", () => {
  it("reloads a live thread of that agent", () => {
    expect(shouldReloadAfterSwitch(base, "claude")).toBe(true);
    expect(shouldReloadAfterSwitch({ ...base, status: "running" }, "claude")).toBe(
      true,
    );
    expect(shouldReloadAfterSwitch({ ...base, status: "waiting" }, "claude")).toBe(
      true,
    );
  });

  it("leaves the other agent alone", () => {
    expect(shouldReloadAfterSwitch(base, "codex")).toBe(false);
    expect(
      shouldReloadAfterSwitch({ ...base, iconKey: "codex", cmd: "codex" }, "claude"),
    ).toBe(false);
  });

  it("skips a row that has never been started", () => {
    expect(
      shouldReloadAfterSwitch(
        { ...base, status: "idle", sessionId: null, ptyId: null },
        "claude",
      ),
    ).toBe(false);
  });

  it("reloads a parked thread that already has a conversation", () => {
    expect(
      shouldReloadAfterSwitch(
        { ...base, status: "idle", ptyId: null, sessionId: "s1" },
        "claude",
      ),
    ).toBe(true);
    expect(
      shouldReloadAfterSwitch(
        { ...base, status: "stopped", ptyId: null, sessionId: null },
        "claude",
      ),
    ).toBe(true);
  });
});
