import { platform as detectPlatform } from "@tauri-apps/plugin-os";
import { backend } from "$lib/backend";

export type Platform = "windows" | "macos" | "linux" | "unknown";

export interface ShellOption {
  id: string;
  label: string;
  cmd: string;
  args: string[];
  iconKey: string | null;
}

class PlatformStore {
  current = $state<Platform>("unknown");
  shells = $state<ShellOption[]>([]);
  ready = $state(false);

  async init() {
    if (this.ready) return;
    try {
      const raw = detectPlatform();
      if (raw === "windows" || raw === "macos" || raw === "linux") {
        this.current = raw;
      }
    } catch (err) {
      console.error("platform detect failed:", err);
    }
    try {
      this.shells = await backend().shell.availableShells();
    } catch (err) {
      console.error("available_shells failed:", err);
    }
    this.ready = true;
  }

  get isWindows() {
    return this.current === "windows";
  }
  get isMacOS() {
    return this.current === "macos";
  }
  get isLinux() {
    return this.current === "linux";
  }
}

export const platform = new PlatformStore();
