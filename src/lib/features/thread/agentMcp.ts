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
 * Agents a button could register in one click. Empty, and checked against each
 * agent's own documentation rather than assumed:
 *
 * - opencode has no `mcp add` at all — only auth/list/logout/debug. Servers go
 *   in `opencode.jsonc` by hand.
 * - cursor exposes MCP only through interactive slash commands (`/mcp list`,
 *   `/mcp enable`); there is no non-interactive add.
 * - copilot, grok and hermes do each document a non-interactive `mcp add`, but
 *   the three take the command differently (`-- CMD ARGS`, `-- CMD ARGS`,
 *   `--command CMD --args ARGS`) and none has been run from here. Copilot
 *   already proved once that a documented subcommand can open a form instead,
 *   so they get the exact line to paste and their own output to read.
 *
 * Registering an agent that cannot then reach the endpoint is worse than not
 * offering it: the button would report success and nothing would work.
 */
const REGISTER_CLI: Partial<Record<NonNullable<IconKey>, string>> = {};

/**
 * What to run, or paste, to give an agent access when Boite cannot hand it
 * anything at launch. One entry per format actually read in that agent's own
 * documentation — an invented line is worse than none, because it is tried.
 */
export function agentSetupSnippet(
  key: IconKey,
  shimPath: string,
  credentialsPath: string,
): string {
  const cmd = JSON.stringify(shimPath);
  const creds = JSON.stringify(credentialsPath);
  switch (key) {
    // Documented as non-interactive: `copilot mcp add NAME -- COMMAND [ARGS…]`.
    // Both paths are quoted: the credentials file lives under "Application
    // Support" on macOS, and a bare space there silently registers two
    // arguments instead of one — which fails nowhere visible, because
    // initialize and tools/list answer without credentials and only tools/call
    // needs them.
    case "copilot":
      return `copilot mcp add boite -- ${cmd} ${creds}`;
    // Everything after `--` is the server command. `--scope project` would
    // write .grok/config.toml into the user's repository instead; user scope is
    // the one that matches a per-project credentials file living outside it.
    case "grok":
      return `grok mcp add boite -- ${cmd} ${creds}`;
    // Flag-based rather than `--`: --args takes the rest of argv and must come
    // last. Lands in the active profile's config.yaml.
    case "hermes":
      return `hermes mcp add boite --command ${cmd} --args ${creds}`;
    // opencode.jsonc, `mcp.<name>` with a command array. No CLI to add one.
    case "opencode":
      return `"boite": { "type": "local", "command": [${cmd}, ${creds}] }`;
    // .cursor/mcp.json, same shape as the editor's. Slash commands only in CLI.
    case "cursor":
      return `"boite": { "command": ${cmd}, "args": [${creds}] }`;
    // ~/.gemini/config/mcp_config.json, shared by the CLI and the IDE. The
    // workspace file is not offered: the project-local one has a standing bug
    // where it is read and then ignored, so a snippet pointing there would look
    // installed and do nothing.
    case "antigravity":
      return `"boite": { "command": ${cmd}, "args": [${creds}] }`;
    default:
      return "";
  }
}

/**
 * The file a pasted snippet belongs in, or null when the snippet is a command
 * to run. A JSON fragment with no destination is a puzzle, and the three that
 * need one all keep it somewhere different.
 */
export function agentSetupTarget(key: IconKey): string | null {
  switch (key) {
    case "opencode":
      return "opencode.jsonc → mcp";
    case "cursor":
      return ".cursor/mcp.json → mcpServers";
    case "antigravity":
      return "~/.gemini/config/mcp_config.json → mcpServers";
    default:
      return null;
  }
}

export async function agentCredentialsPath(projectId: string): Promise<string | null> {
  if (!hasTauri()) return null;
  try {
    return await invoke<string>("agent_mcp_project_path", { projectId });
  } catch {
    return null;
  }
}

export function agentRegisterCli(key: IconKey): string | null {
  return (key && REGISTER_CLI[key]) ?? null;
}

/**
 * Whether the agent's binary resolves on PATH. The panel asks before claiming
 * Boite would wire an agent: a thread can outlive the tool that made it — click
 * a shortcut once on a machine without that CLI and the thread stays for good.
 */
export async function agentIsInstalled(cmd: string): Promise<boolean> {
  if (!hasTauri()) return false;
  try {
    return await invoke<boolean>("check_command_exists", { cmd });
  } catch {
    return false;
  }
}

/** Whether the endpoint an injected agent would call is actually serving. */
export async function agentApiReady(): Promise<boolean> {
  if (!hasTauri()) return false;
  try {
    return await invoke<boolean>("agent_api_ready");
  } catch {
    return false;
  }
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

/** Runs the agent's own `mcp add`. Returns what it said, or throws its error. */
export async function registerAgentMcp(cli: string): Promise<string> {
  const paths = await mcpPaths();
  if (!paths) throw new Error("no shim available");
  return invoke<string>("register_agent_mcp", {
    cli,
    sidecarPath: paths.sidecarPath,
  });
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
  const paths = await mcpPaths();
  if (!paths) return [];
  return injector(paths);
}
