import { messageOf } from '../../errors.ts';
import type { CodexRpc } from './rpc.ts';

/**
 * A title call and a fork setup run no turn that needs the user's plugins or
 * connectors, so their app-server starts without them. An older codex ignores
 * an unknown feature with one `configWarning`.
 */
export const BACKGROUND_FEATURES_OFF = ['--config', 'features.plugins=false', '--config', 'features.apps=false'] as const;

/**
 * The `config` entry that keeps every MCP server the user configured from
 * starting with the next `thread/start` or `thread/fork` of this process.
 * Codex starts them for any thread it opens, and its override layers merge
 * tables, so an empty `mcp_servers` table would start them all the same. The
 * names come from `config/read` rather than from parsing `config.toml`. The
 * nested form, not a dotted key, keeps a server name with a dot whole. Empty
 * when the server cannot say: the thread then opens as it always did.
 */
export async function mcpServersOff(
  rpc: CodexRpc,
  cwd: string,
  log: (level: 'info', message: string) => void,
  timeoutMs: number,
): Promise<{ mcp_servers?: Record<string, { enabled: false }> }> {
  try {
    const read = await rpc.request<{ config?: { mcp_servers?: Record<string, unknown> | null } }>('config/read', { includeLayers: false, cwd }, { timeoutMs });
    const names = Object.keys(read?.config?.mcp_servers ?? {});
    return names.length === 0 ? {} : { mcp_servers: Object.fromEntries(names.map(name => [name, { enabled: false as const }])) };
  } catch (error) {
    log('info', `codex: config/read failed, MCP servers start as configured: ${messageOf(error)}`);
    return {};
  }
}
