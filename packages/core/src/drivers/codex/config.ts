import { messageOf } from '../../errors.ts';
import { THREAD_CONFIG } from './protocol.ts';
import type { CodexRpc } from './rpc.ts';

/** The keys of `config/read`'s effective configuration this driver reads. */
interface CodexConfig {
  mcp_servers?: Record<string, { enabled?: boolean } | null> | null;
  mcp_optional_startup_grace_ms?: number | null;
}

/**
 * How long `config/read` may take. It reads local files, so a Codex silent past
 * this is treated like one that refused it rather than hold the thread open.
 * Mutable for the tests.
 */
export const CONFIG_READ = { timeoutMs: 10_000 };

/** The effective configuration of `cwd`: the user's and the project's `config.toml` layers merged by Codex. */
export async function readConfig(rpc: CodexRpc, cwd: string): Promise<CodexConfig> {
  const read = await rpc.request<{ config?: CodexConfig | null }>('config/read', { cwd }, { timeoutMs: CONFIG_READ.timeoutMs });
  return read?.config ?? {};
}

/**
 * `THREAD_CONFIG` for a thread opened in `cwd`. A grace the user set in
 * `config.toml`, `0` included (Codex then waits for each server's own
 * `startup_timeout_sec`), is left to stand; Boite's 10 s goes only where none
 * is set. A Codex that cannot answer `config/read` gets the 10 s. `serversOff`
 * also turns off every MCP server, for a process that runs no turn (a fork's
 * setup); one that cannot list them starts them as configured.
 */
export async function threadConfig(rpc: CodexRpc, cwd: string, log: (level: 'info' | 'warn' | 'error', message: string) => void, serversOff = false, mandatory = false): Promise<Record<string, unknown>> {
  try {
    const config = await readConfig(rpc, cwd);
    const servers = serversOff ? mcpServersOff(config) : null;
    const { mcp_optional_startup_grace_ms: _ours, ...rest } = THREAD_CONFIG;
    const base = typeof config.mcp_optional_startup_grace_ms === 'number' ? rest : THREAD_CONFIG;
    return servers === null ? base : { ...base, mcp_servers: servers };
  } catch (error) {
    if (mandatory) throw new Error(`execution.codex.config: cannot enumerate and disable configured MCP servers (${messageOf(error)})`);
    log('info', `codex: config/read failed (${messageOf(error)}); the MCP startup grace is ${THREAD_CONFIG.mcp_optional_startup_grace_ms} ms`);
    return THREAD_CONFIG;
  }
}

/**
 * The `thread/start` override that turns off every MCP server the effective
 * config declares. Each server is named, since an override of `mcp_servers`
 * merges into the user's servers rather than replacing them, and nested so a
 * name with a dot stays one key. A server already off is left out. Built with
 * `Object.fromEntries` so any name, `__proto__` included, is an own key.
 */
export function mcpServersOff(config: CodexConfig): Record<string, { enabled: false }> | null {
  const names = Object.entries(config.mcp_servers ?? {}).filter(([, server]) => server?.enabled !== false).map(([name]) => name);
  return names.length === 0 ? null : Object.fromEntries(names.map(name => [name, { enabled: false as const }]));
}
