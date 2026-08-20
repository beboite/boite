import { describe, expect, it } from "vitest";
import {
  accountProviderOf,
  shouldReloadCodexThread,
  shouldReloadProviderThread,
} from "./restart";

const base = {
  cmd: "codex",
  label: "Codex",
  iconKey: "codex" as const,
  status: "ready" as const,
  sessionId: "s1",
  ptyId: "p1",
};

describe("shouldReloadCodexThread", () => {
  it("reloads a live Codex thread", () => {
    expect(shouldReloadCodexThread(base)).toBe(true);
  });

  it("leaves Claude alone", () => {
    expect(shouldReloadCodexThread({ ...base, iconKey: "claude", cmd: "claude" })).toBe(
      false,
    );
  });

  it("skips a row that has never been started", () => {
    expect(
      shouldReloadCodexThread({
        ...base,
        status: "idle",
        sessionId: null,
        ptyId: null,
      }),
    ).toBe(false);
  });
});

describe("shouldReloadProviderThread", () => {
  it("reloads a live Claude thread for a Claude switch", () => {
    expect(
      shouldReloadProviderThread(
        { ...base, iconKey: "claude", cmd: "claude", label: "Claude" },
        "claude",
      ),
    ).toBe(true);
  });

  it("reloads antigravity the same way", () => {
    expect(
      shouldReloadProviderThread(
        { ...base, iconKey: "antigravity", cmd: "antigravity", label: "Antigravity" },
        "antigravity",
      ),
    ).toBe(true);
  });

  it("leaves the other provider alone", () => {
    expect(shouldReloadProviderThread(base, "claude")).toBe(false);
  });

  it("counts a fastpick Claude row as Claude", () => {
    expect(
      accountProviderOf({
        iconKey: "claude",
        cmd: "fastpick",
        label: "Claude",
      }),
    ).toBe("claude");
  });
});
