import { describe, expect, it } from "vitest";
import { PLUGINS } from "./spec";
import { CODEX_SWITCHER_CMD, CODEX_SWITCHER_REPO } from "./install";
import { FAST_MCP_SSH_CMD, FAST_MCP_SSH_REPO } from "./fast-mcp-ssh";

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

  it("names the real MCP server", () => {
    const ssh = PLUGINS.find((plugin) => plugin.id === "fast-mcp-ssh");
    expect(ssh?.repo).toBe(FAST_MCP_SSH_REPO);
    expect(FAST_MCP_SSH_CMD).toBe("fast-mcp-ssh");
  });

  it("gives every plugin its own id", () => {
    expect(new Set(PLUGINS.map((plugin) => plugin.id)).size).toBe(PLUGINS.length);
  });
});
