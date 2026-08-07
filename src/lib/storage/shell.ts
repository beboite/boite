import { backendFor, workspace } from "$lib/backend";
import { deviceOS } from "$lib/storage/platform.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import type { WorkspaceOrigin } from "$lib/types";

// Keyed by origin ("default" covers the classic single-backend modes): in
// dynamic mode the boite's default shell (Linux) and the local one (Windows)
// coexist.
const cached = new Map<string, string>();

// Reached only when the RPC that would have answered failed, so the OS of the
// machine that was supposed to answer is exactly what is not available. The
// device's OS is the right guess for the local backend and the wrong one for
// every other case: one failed probe against a Linux boite used to spawn
// `cmd.exe` there, and the thread died with nothing on screen explaining it.
function fallback(origin?: WorkspaceOrigin): string {
  const isLocalMachine = origin === "local" || (origin === undefined && !workspace.hasRemote);
  if (isLocalMachine && deviceOS === "windows") return "cmd.exe";
  return "/bin/sh";
}

// The default shell differs per workspace (a Linux server vs the local OS), so
// a workspace switch must drop the cache.
export function resetShellCache(): void {
  cached.clear();
}

export async function getDefaultShell(origin?: WorkspaceOrigin): Promise<string> {
  const key = origin ?? "default";
  const hit = cached.get(key);
  if (hit) return hit;
  let shell: string;
  try {
    shell = await backendFor(origin).shell.defaultShell();
  } catch (err) {
    logger.warn("shell", "default_shell failed, using the platform fallback", String(err));
    shell = fallback(origin);
  }
  cached.set(key, shell);
  return shell;
}
