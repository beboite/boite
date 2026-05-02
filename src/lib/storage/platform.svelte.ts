import { invoke } from "@tauri-apps/api/core";
import { platform as detectPlatform } from "@tauri-apps/plugin-os";

export type Platform = "windows" | "macos" | "linux" | "unknown";

export interface ShellOption {
  id: string;
  label: string;
  cmd: string;
  args: string[];
  iconKey: string | null;
}

interface RawShellOption {
  id: string;
  label: string;
  cmd: string;
  args: string[];
  icon_key: string | null;
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
      const list = await invoke<RawShellOption[]>("available_shells");
      this.shells = list.map((s) => ({
        id: s.id,
        label: s.label,
        cmd: s.cmd,
        args: s.args,
        iconKey: s.icon_key,
      }));
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
