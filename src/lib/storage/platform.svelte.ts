import { backend } from "$lib/backend";
import { logger } from "$lib/shared/services/logger.svelte";

export type Platform = "windows" | "macos" | "linux" | "unknown";

export interface ShellOption {
  id: string;
  label: string;
  cmd: string;
  args: string[];
  iconKey: string | null;
}

// The OS of the machine the threads run on, and the shells that machine offers.
// Both come from the active backend rather than from this device: they are read
// together (the shell list only makes sense against the OS that produced it), and
// asking the device gave the wrong answer twice over. In a browser there is no
// device OS to ask at all, so `isMacOS` stayed false and Cmd routing never
// happened; on a Windows desktop driving a Linux boite the OS was Windows and the
// shell list was the boite's, so the default shell was picked out of a Windows
// preference order against a set of Linux shells.
class PlatformStore {
  current = $state<Platform>("unknown");
  shells = $state<ShellOption[]>([]);
  ready = $state(false);

  async init() {
    if (this.ready) return;
    try {
      this.current = await backend().system.platform();
    } catch (err) {
      logger.error("platform", "detect failed", err);
    }
    try {
      this.shells = await backend().shell.availableShells();
    } catch (err) {
      logger.error("platform", "available_shells failed", err);
    }
    this.ready = true;
  }

  // Re-read both on the next init. `current` is cleared with the shells rather
  // than left behind: a workspace switch changes which machine is answering, and
  // keeping the previous OS while replacing its shell list is the mismatch this
  // store exists to avoid.
  reset() {
    this.ready = false;
    this.shells = [];
    this.current = "unknown";
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
