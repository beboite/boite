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
export interface McpPaths {
  /** Generated JSON file, for agents that take a config document. */
  configPath: string;
  /** The shim binary itself, for agents that take a command. */
  sidecarPath: string;
}

export type McpInjection = (paths: McpPaths) => string[];

const INJECTORS: Partial<Record<NonNullable<IconKey>, McpInjection>> = {
  // Takes a path or a raw JSON string. The path is what we pass: Boite often
  // launches through a wrap shell, which re-quotes arguments and escapes `"` as
  // `\"` — accepted by POSIX shells, not by PowerShell. A path carries neither
  // quotes nor braces and survives all of them.
  claude: ({ configPath }) => ["--mcp-config", configPath],
  // A per-invocation TOML override; codex has no file equivalent. The value
  // carries quotes, which is why this waited on the wrap shell learning to
  // quote for PowerShell — before that it was silently broken on Windows only.
  codex: ({ sidecarPath }) => [
    "-c",
    `mcp_servers.boite.command=${JSON.stringify(sidecarPath)}`,
  ],
};

/**
 * Agents that keep their servers in a config file but expose an `mcp add`
 * subcommand, so the registration can still be one click. The value is the
 * binary to run, which is not always the icon key.
 */
const REGISTER_CLI: Partial<Record<NonNullable<IconKey>, string>> = {
  opencode: "opencode",
  cursor: "cursor-agent",
};

export function agentRegisterCli(key: IconKey): string | null {
  return (key && REGISTER_CLI[key]) ?? null;
}

/** Agents Boite can point at the endpoint with no setup from the user. */
export function agentAcceptsInjection(key: IconKey): boolean {
  return !!key && key in INJECTORS;
}

let cached: McpPaths | null = null;
let failed = false;

/**
 * Where the generated server definition lives, or null when there is none to
 * offer — a browser workspace, or a dev build whose sidecar was never compiled.
 * Failure is remembered so a launch never pays for the same missing file twice.
 */
export async function mcpPaths(): Promise<McpPaths | null> {
  if (cached) return cached;
  if (failed || !hasTauri()) return null;
  try {
    cached = await invoke<McpPaths>("agent_mcp_config");
    return cached;
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
/** Runs the agent's own `mcp add`. Returns what it said, or throws its error. */
export async function registerAgentMcp(cli: string): Promise<string> {
  const paths = await mcpPaths();
  if (!paths) throw new Error("no shim available");
  return invoke<string>("register_agent_mcp", {
    cli,
    sidecarPath: paths.sidecarPath,
  });
}

export async function mcpArgsFor(key: IconKey, enabled: boolean): Promise<string[]> {
  if (!enabled) return [];
  const injector = key ? INJECTORS[key] : undefined;
  if (!injector) return [];
  const paths = await mcpPaths();
  if (!paths) return [];
  return injector(paths);
}
