import { platform as detectPlatform } from "@tauri-apps/plugin-os";
import { backend, backendFor, workspace } from "$lib/backend";
import { hasTauri } from "$lib/backend/env";
import { logger } from "$lib/shared/services/logger.svelte";
import type { WorkspaceOrigin } from "$lib/types";

export type Platform = "windows" | "macos" | "linux" | "unknown";

export interface ShellOption {
  id: string;
  label: string;
  cmd: string;
  args: string[];
  iconKey: string | null;
}

// Two machines, two questions, and for the whole local-only history of the app
// they had one answer. `host` is the machine the threads run on; `device` is the
// machine the user is typing on. A remote workspace pulls them apart, and every
// caller now has to say which one it means: the getters are named for it rather
// than left as a bare `isMacOS` that reads correct either way.
//
// Asking the device for the host's OS gave the wrong answer twice over: in a
// browser there is no device OS to ask at all, so the shell list came back
// Linux and was picked out of a Windows preference order. Asking the host for
// the device's OS is the mirror mistake, and it rebound the whole keyboard: a
// Mac driving a Linux boite demanded Ctrl for every `mod+` binding, so Cmd+K
// did nothing and Ctrl+K opened the palette instead of readline's kill-line.

// The device answer needs no backend and no boot: the keyboard controller
// attaches from its own `onMount`, which runs on the PWA path where the
// workspace never initialises. Computed once, since an OS does not change under
// a running window.
function detectDeviceOS(): Platform {
  if (hasTauri()) {
    try {
      const p = detectPlatform();
      if (p === "windows" || p === "macos" || p === "linux") return p;
      // ios/android and anything else the plugin grows: not one of the three
      // the keyboard rules are written against.
      return "unknown";
    } catch {
      // Falls through to the browser sniff rather than answering "unknown":
      // the webview has a navigator either way.
    }
  }
  if (typeof navigator === "undefined") return "unknown";
  // `userAgentData` is the non-deprecated half and answers "macOS"/"Windows"/
  // "Linux"; `platform` is the fallback for the browsers that lack it.
  const ua = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData?.platform;
  const raw = `${ua ?? ""} ${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  // iPadOS reports a Mac platform string, which is the right answer here: its
  // keyboards carry a Command key and the chords are spelled the Mac way.
  if (/mac|iphone|ipad|ipod/i.test(raw)) return "macos";
  if (/win/i.test(raw)) return "windows";
  if (/linux|android|cros/i.test(raw)) return "linux";
  return "unknown";
}

const DEVICE_OS: Platform = detectDeviceOS();

/** The OS of the machine the user is looking at. Never the boite's. */
export const deviceOS: Platform = DEVICE_OS;
export const isDeviceMacOS = DEVICE_OS === "macos";
export const isDeviceWindows = DEVICE_OS === "windows";
export const isDeviceLinux = DEVICE_OS === "linux";

// The OS of the machine the threads run on, and the shells that machine offers.
// Both come from the active backend and are read together: the shell list only
// makes sense against the OS that produced it.
//
// Dynamic mode has two of those machines, so it has two lists. `host` and
// `shells` are the workspace-global backend's, which is the local one there;
// the boite's shells are `remoteShells`. No launcher reads either field: it
// asks `shellsFor(origin)`, because a menu drawn from the other machine's list
// offers rows that cannot start. What still reads `shells` on its own is the
// default-shell setting, which is one id and therefore one machine's by
// construction; the launch resolves it against the target's list.
class PlatformStore {
  host = $state<Platform>("unknown");
  shells = $state<ShellOption[]>([]);
  // The boite's own shells, dynamic mode only. Empty everywhere else, where
  // `shells` already describes the single machine every origin routes to.
  remoteShells = $state<ShellOption[]>([]);
  ready = $state(false);
  // Whether the host ever answered. A failed probe leaves `host` at "unknown",
  // which is a different thing from a host that really is none of the three,
  // and callers that would otherwise silently take the POSIX branch can ask.
  hostKnown = $state(false);

  async init() {
    if (this.ready) return;
    // Together, not in series: none of the three waits on another and boot
    // waits on all of them, so a second machine's list would otherwise have put
    // a whole remote round trip in front of the first paint.
    const [host, local, remote] = await Promise.allSettled([
      backend().system.platform(),
      backend().shell.availableShells(),
      // Only dynamic mode has a second machine to ask. Every other mode routes
      // every origin to the backend already asked above, so a second call there
      // would be the same list twice.
      workspace.isDynamic
        ? backendFor("remote").shell.availableShells()
        : Promise.resolve<ShellOption[]>([]),
    ]);
    if (host.status === "fulfilled") {
      this.host = host.value;
      this.hostKnown = this.host !== "unknown";
    } else {
      logger.error("platform", "detect failed", host.reason);
    }
    if (local.status === "fulfilled") this.shells = local.value;
    else logger.error("platform", "available_shells failed", local.reason);
    // A boite that cannot answer leaves the list empty rather than borrowing
    // the local one: a launcher with nothing to offer falls back to that
    // machine's own default shell, which is the honest answer there.
    if (remote.status === "fulfilled") this.remoteShells = remote.value;
    else logger.error("platform", "available_shells on the boite failed", remote.reason);
    this.ready = true;
  }

  // Re-read all of them on the next init. `host` is cleared with the shells
  // rather than left behind: a workspace switch changes which machine is
  // answering, and keeping the previous OS while replacing its shell list is
  // the mismatch this store exists to avoid.
  reset() {
    this.ready = false;
    this.shells = [];
    this.remoteShells = [];
    this.host = "unknown";
    this.hostKnown = false;
  }

  /**
   * The shells of the machine a launch with this origin would land on.
   *
   * Dynamic mode is the only one where the question is not rhetorical, and it
   * is the mode where getting it wrong sent a Windows shell path to a Linux
   * boite. Everywhere else there is one machine and one list, so the origin is
   * ignored rather than consulted, which is the rule `workspace.backendFor`
   * already follows.
   */
  shellsFor(origin: WorkspaceOrigin | undefined): ShellOption[] {
    if (!workspace.isDynamic) return this.shells;
    return origin === "remote" ? this.remoteShells : this.shells;
  }

  /**
   * Whether that list belongs to a boite rather than to this machine.
   *
   * Dynamic mode only, because it is the only one where the answer changes as
   * the user moves between projects and nothing else on screen says so. A pure
   * remote workspace is a boite from end to end and the titlebar already names
   * it.
   */
  shellsOnBoite(origin: WorkspaceOrigin | undefined): boolean {
    return workspace.isDynamic && origin === "remote";
  }

  get isHostWindows() {
    return this.host === "windows";
  }
  get isHostMacOS() {
    return this.host === "macos";
  }
  get isHostLinux() {
    return this.host === "linux";
  }
}

export const platform = new PlatformStore();
