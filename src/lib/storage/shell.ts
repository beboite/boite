import { platform as detectPlatform } from "@tauri-apps/plugin-os";
import { backend } from "$lib/backend";

let cached: string | null = null;

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
  cached = null;
}

export async function getDefaultShell(): Promise<string> {
  if (cached) return cached;
  try {
    cached = await backend().shell.defaultShell();
  } catch (err) {
    console.error("default_shell failed:", err);
    cached = fallback();
  }
  return cached;
}
