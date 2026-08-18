import { describe, expect, it } from "vitest";
import { shouldReloadCodexThread } from "./restart";

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
