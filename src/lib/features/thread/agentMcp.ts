import { invoke } from "@tauri-apps/api/core";
import { hasTauri } from "$lib/backend/env";
import { logger } from "$lib/shared/services/logger.svelte";
import type { IconKey } from "$lib/types";

/**
 * Pointing an agent at Boite's todo endpoint without anyone installing
 * anything.
 *
 * Only agents that accept a server definition *at launch* are wired here.
 * Everything else keeps its servers in a config file — `~/.codex/config.toml`,
 * `opencode.json`, `.cursor/mcp.json`, hermes' `config.yaml` — and writing into
 * those is a different act entirely: it outlives Boite, and for the
 * project-scoped ones it lands in the user's repository. Those get an explicit
 * button in the panel rather than a silent write.
 */
export type McpInjection = (configPath: string) => string[];

const INJECTORS: Partial<Record<NonNullable<IconKey>, McpInjection>> = {
  // Takes a path or a raw JSON string. The path is what we pass: Boite often
  // launches through a wrap shell, which re-quotes arguments and escapes `"` as
  // `\"` — accepted by POSIX shells, not by PowerShell. A path carries neither
  // quotes nor braces and survives all of them.
  claude: (configPath) => ["--mcp-config", configPath],
};

/** Agents Boite can point at the endpoint with no setup from the user. */
export function agentAcceptsInjection(key: IconKey): boolean {
  return !!key && key in INJECTORS;
}

let cached: { configPath: string } | null = null;
let failed = false;

/**
 * Where the generated server definition lives, or null when there is none to
 * offer — a browser workspace, or a dev build whose sidecar was never compiled.
 * Failure is remembered so a launch never pays for the same missing file twice.
 */
export async function mcpConfigPath(): Promise<string | null> {
  if (cached) return cached.configPath;
  if (failed || !hasTauri()) return null;
  try {
    const res = await invoke<{ configPath: string }>("agent_mcp_config");
    cached = { configPath: res.configPath };
    return res.configPath;
  } catch (err) {
    failed = true;
    logger.warn("mcp", "agent todo access unavailable", String(err));
    return null;
  }
}

/**
 * Extra launch arguments giving this agent access to its project's todo list,
 * or nothing when the agent cannot take them, access is switched off, or the
 * shim is missing.
 */
export async function mcpArgsFor(key: IconKey, enabled: boolean): Promise<string[]> {
  if (!enabled) return [];
  const injector = key ? INJECTORS[key] : undefined;
  if (!injector) return [];
  const configPath = await mcpConfigPath();
  if (!configPath) return [];
  return injector(configPath);
}
