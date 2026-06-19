import { tick } from "svelte";
import { backend, workspace } from "$lib/backend";
import { hasTauri } from "$lib/backend/env";
import { app } from "./store.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { platform } from "$lib/storage/platform.svelte";
import { resetShellCache } from "$lib/storage/shell";
import { gitStore } from "$lib/features/git/store.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { device, type BoiteEntry } from "$lib/features/settings/device.svelte";
import { registerPush } from "$lib/features/push/api";

// In a browser/PWA the only backend is the server that served this page.
export function defaultRemoteWsUrl(): string {
  if (typeof location === "undefined") return "";
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

// Drop every workspace-scoped store so init() re-hydrates from the new backend
// instead of mixing two workspaces.
function resetStores() {
  settings.reset();
  platform.reset();
  resetShellCache();
  gitStore.reset();
  app.reset();
}

// Bump the epoch, then yield so the {#key} remount tears down every Terminal
// (each releases its PTY) BEFORE the transport swaps under it. Local terminals
// kill; remote terminals detach and the server keeps the PTY alive.
async function tearDownTerminals() {
  workspace.bumpEpoch();
  await tick();
}

// Pull the server-synced name/color of the freshly connected boite and cache
// it on the device registry so the picker can label it later without a
// connection. Fire-and-forget: a failure just leaves the cached label.
async function fetchAndApplyMeta() {
  const meta = backend().meta;
  if (!meta) return;
  try {
    const info = await meta.get();
    workspace.info = { name: info.name, color: info.color };
    if (workspace.activeBoiteId) {
      device.updateBoite(workspace.activeBoiteId, {
        name: info.name ?? "",
        color: info.color ?? "",
      });
    }
  } catch {
    // keep the cached label
  }
}

// Leaving the local workspace is non-destructive now: local PTYs are detached
// (kept alive + buffering) on the switch and reattach when you come back, so
// there is nothing to warn about.
async function confirmLeaveLocal(): Promise<boolean> {
  return true;
}

// Connect to a saved boite and initialize the app against it. `reset` tears the
// current workspace down first (store reset + terminal remount); it is skipped
// at boot, where nothing is initialized yet.
async function connectBoite(entry: BoiteEntry, reset: boolean): Promise<boolean> {
  try {
    await workspace.createRemote(entry.url, entry.token);
  } catch (err) {
    console.error("remote connect failed:", err);
    notifications.error("Remote connection failed");
    return false;
  }
  if (reset) {
    await tearDownTerminals();
    resetStores();
  }
  workspace.activateRemote();
  workspace.setActiveBoite(entry.id);
  // Seed the label/color from the device cache so the pill shows this boite's
  // identity immediately; fetchAndApplyMeta refreshes it from the server.
  workspace.info = { name: entry.name || null, color: entry.color || null };
  workspace.needsLogin = false;
  device.setActive(entry.id);
  await app.init();
  void fetchAndApplyMeta();
  // Fire-and-forget: a denied/unsupported push permission must not block boot.
  void registerPush();
  return true;
}

export async function switchToLocal(): Promise<boolean> {
  // No local backend in a browser/PWA: there is nowhere to switch to.
  if (!hasTauri()) return false;
  if (workspace.mode === "local") return true;
  await tearDownTerminals();
  resetStores();
  workspace.activateLocal();
  await app.init();
  notifications.success("Back to local workspace");
  return true;
}

// Switch to an already-saved boite. No-op when it is already the active,
// connected workspace.
export async function switchToBoite(id: string): Promise<boolean> {
  const entry = device.getBoite(id);
  if (!entry) return false;
  if (
    workspace.mode === "remote" &&
    workspace.activeBoiteId === id &&
    workspace.connection === "connected"
  ) {
    return true;
  }
  if (!(await confirmLeaveLocal())) return false;
  return connectBoite(entry, app.ready);
}

// PWA boot: connect to the last-active saved boite, or raise the login gate.
// Called instead of app.init() when there is no Tauri runtime.
export async function bootRemoteWorkspace(): Promise<boolean> {
  const entry = device.active ?? device.boites[0] ?? null;
  if (!entry) {
    workspace.needsLogin = true;
    return false;
  }
  const ok = await connectBoite(entry, false);
  if (!ok) workspace.needsLogin = true;
  return ok;
}

// Register a new boite (or re-pair an existing URL) and connect to it. Used by
// the login screen and the "add boite" action in the workspace picker.
export async function connectAndInit(url: string, token: string): Promise<boolean> {
  if (!(await confirmLeaveLocal())) return false;
  const entry = device.addBoite(url, token);
  return connectBoite(entry, app.ready);
}

// Push a cosmetic name/color change to the active boite. The server persists it
// and broadcasts workspace.info, so every other connected device updates live.
export async function setActiveBoiteInfo(patch: {
  name?: string | null;
  color?: string | null;
}): Promise<void> {
  const meta = backend().meta;
  if (!meta) return;
  try {
    const res = await meta.set(patch);
    workspace.info = { name: res.name, color: res.color };
    if (workspace.activeBoiteId) {
      device.updateBoite(workspace.activeBoiteId, {
        name: res.name ?? "",
        color: res.color ?? "",
      });
    }
  } catch (err) {
    console.error("workspace setInfo failed:", err);
    notifications.error("Update failed");
  }
}
