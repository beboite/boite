import { invoke } from "@tauri-apps/api/core";

let cached: string | null = null;

export async function getDefaultShell(): Promise<string> {
  if (cached) return cached;
  try {
    cached = await invoke<string>("default_shell");
  } catch (err) {
    console.error("default_shell failed:", err);
    cached = "pwsh";
  }
  return cached;
}
