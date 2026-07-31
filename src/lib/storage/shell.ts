import { platform as detectPlatform } from "@tauri-apps/plugin-os";
import { backendFor } from "$lib/backend";
import { logger } from "$lib/shared/services/logger.svelte";
import type { WorkspaceOrigin } from "$lib/types";

// Keyed by origin ("default" covers the classic single-backend modes): in
// dynamic mode the boite's default shell (Linux) and the local one (Windows)
// coexist.
const cached = new Map<string, string>();

function fallback(): string {
  try {
    const p = detectPlatform();
    if (p === "windows") return "cmd.exe";
    return "/bin/sh";
  } catch {
    return "/bin/sh";
  }
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
    shell = fallback();
  }
  cached.set(key, shell);
  return shell;
}
