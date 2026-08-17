import { describe, expect, it } from "vitest";
import { PLUGINS, isInstallable } from "./spec";

describe("plugin catalogue", () => {
  it("only marks a plugin installable when it has a published repo", () => {
    const fastpick = PLUGINS.find((p) => p.id === "fastpick");
    const claude = PLUGINS.find((p) => p.id === "claude-switcher");
    const codex = PLUGINS.find((p) => p.id === "codex-switcher");
    expect(fastpick && isInstallable(fastpick)).toBe(true);
    expect(claude && isInstallable(claude)).toBe(false);
    expect(codex && isInstallable(codex)).toBe(false);
  });

  it("does not invent a binary name for an unpublished slot", () => {
    for (const plugin of PLUGINS) {
      if (!isInstallable(plugin)) {
        expect(plugin.repo).toBeNull();
      }
    }
  });
});
