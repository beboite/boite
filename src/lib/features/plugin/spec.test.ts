import { describe, expect, it } from "vitest";
import { PLUGINS } from "./spec";
import { CODEX_SWITCHER_CMD, CODEX_SWITCHER_REPO } from "./install";

describe("plugin catalogue", () => {
  it("only lists published tools", () => {
    expect(PLUGINS.every((plugin) => plugin.repo.startsWith("https://"))).toBe(true);
    expect(PLUGINS.some((plugin) => plugin.id === "claude-switcher")).toBe(false);
  });

  it("names the real Codex CLI", () => {
    const codex = PLUGINS.find((plugin) => plugin.id === "codex-account-switcher");
    expect(codex?.repo).toBe(CODEX_SWITCHER_REPO);
    expect(CODEX_SWITCHER_CMD).toBe("codex-account-switcher");
  });
});
