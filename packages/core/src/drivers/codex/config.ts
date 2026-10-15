import { messageOf } from '../../errors.ts';
import { THREAD_CONFIG } from './protocol.ts';
import type { CodexRpc } from './rpc.ts';

/** The keys of `config/read`'s effective configuration this driver reads. */
interface CodexConfig {
  mcp_servers?: Record<string, { enabled?: boolean } | null> | null;
  mcp_optional_startup_grace_ms?: number | null;
}

/** The effective configuration of `cwd`: the user's and the project's `config.toml` layers merged by Codex. */
export async function readConfig(rpc: CodexRpc, cwd: string): Promise<CodexConfig> {
  const read = await rpc.request<{ config?: CodexConfig | null }>('config/read', { cwd });
  return read?.config ?? {};
}

/**
 * `THREAD_CONFIG` for a thread opened in `cwd`. A grace the user set in
 * `config.toml`, `0` included (Codex then waits for each server's own
 * `startup_timeout_sec`), is left to stand; Boite's 10 s goes only where none
 * is set. A Codex that cannot answer `config/read` gets the 10 s.
 */
export async function threadConfig(rpc: CodexRpc, cwd: string, log: (level: 'info' | 'warn' | 'error', message: string) => void): Promise<Record<string, unknown>> {
  try {
    const config = await readConfig(rpc, cwd);
    if (typeof config.mcp_optional_startup_grace_ms !== 'number') return THREAD_CONFIG;
    const { mcp_optional_startup_grace_ms: _ours, ...rest } = THREAD_CONFIG;
    return rest;
  } catch (error) {
    log('info', `codex: config/read failed (${messageOf(error)}); the MCP startup grace is ${THREAD_CONFIG.mcp_optional_startup_grace_ms} ms`);
    return THREAD_CONFIG;
  }
}

/**
 * The `thread/start` override that turns off every MCP server the effective
 * config declares. Each server is named, since an override of `mcp_servers`
 * merges into the user's servers rather than replacing them, and nested so a
 * name with a dot stays one key. A server already off is left out.
 */
export function mcpServersOff(config: CodexConfig): Record<string, { enabled: false }> | null {
  const off: Record<string, { enabled: false }> = {};
  for (const [name, server] of Object.entries(config.mcp_servers ?? {})) {
    if (server?.enabled !== false) off[name] = { enabled: false };
  }
  return Object.keys(off).length === 0 ? null : off;
}
