import { describe, expect, it } from "vitest";
import { kebaccProviderOf, shouldReloadCodexThread, shouldReloadKebaccThread } from "./restart";

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

describe("shouldReloadKebaccThread", () => {
  it("reloads a live Claude thread for a Claude switch", () => {
    expect(
      shouldReloadKebaccThread(
        { ...base, iconKey: "claude", cmd: "claude", label: "Claude" },
        "claude",
      ),
    ).toBe(true);
  });

  it("reloads a live Codex thread for a Codex switch", () => {
    expect(shouldReloadKebaccThread(base, "codex")).toBe(true);
  });

  it("leaves the other provider alone", () => {
    expect(shouldReloadKebaccThread(base, "claude")).toBe(false);
    expect(
      shouldReloadKebaccThread(
        { ...base, iconKey: "claude", cmd: "claude", label: "Claude" },
        "codex",
      ),
    ).toBe(false);
  });

  it("skips a row that has never been started", () => {
    expect(
      shouldReloadKebaccThread(
        { ...base, status: "idle", sessionId: null, ptyId: null },
        "codex",
      ),
    ).toBe(false);
  });

  it("counts a fastpick Claude row as Claude", () => {
    expect(
      kebaccProviderOf({
        iconKey: "claude",
        cmd: "fastpick",
        label: "Claude",
      }),
    ).toBe("claude");
  });
});
