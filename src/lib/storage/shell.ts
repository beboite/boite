import { invoke } from "@tauri-apps/api/core";
import { platform as detectPlatform } from "@tauri-apps/plugin-os";

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

export async function getDefaultShell(): Promise<string> {
  if (cached) return cached;
  try {
    cached = await invoke<string>("default_shell");
  } catch (err) {
    console.error("default_shell failed:", err);
    cached = fallback();
  }
  return cached;
}
