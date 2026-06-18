import { tick } from "svelte";
import { workspace } from "$lib/backend";
import { hasTauri } from "$lib/backend/env";
import { app } from "./store.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { platform } from "$lib/storage/platform.svelte";
import { resetShellCache } from "$lib/storage/shell";
import { gitStore } from "$lib/features/git/store.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { confirmDialog } from "$lib/shared/components/confirm.svelte";
import { device } from "$lib/features/settings/device.svelte";
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

export async function switchToRemote(url: string, token: string): Promise<boolean> {
  if (
    workspace.mode === "local" &&
    app.threads.some((t) => t.ptyId)
  ) {
    const ok = await confirmDialog.ask({
      title: "Switch to remote?",
      message: "Local running processes will be killed.",
      confirmLabel: "Switch",
      danger: true,
    });
    if (!ok) return false;
  }

  try {
    await workspace.createRemote(url, token);
  } catch (err) {
    console.error("remote connect failed:", err);
    notifications.error("Remote connection failed");
    return false;
  }

  await tearDownTerminals();
  resetStores();
  workspace.activateRemote();
  await app.init();
  notifications.success("Connected to remote workspace");
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

// PWA boot: connect to the serving origin with the saved token, or raise the
// login gate. Called instead of app.init() when there is no Tauri runtime.
export async function bootRemoteWorkspace(): Promise<boolean> {
  const url = device.state.remoteUrl || defaultRemoteWsUrl();
  const token = device.state.remoteToken;
  if (!token) {
    workspace.needsLogin = true;
    return false;
  }
  const ok = await connectAndInit(url, token);
  if (!ok) workspace.needsLogin = true;
  return ok;
}

// Connect a remote backend and initialize the app against it. Used by the PWA
// boot path and the login screen (not the desktop local<->remote switch, which
// must reset stores first).
export async function connectAndInit(url: string, token: string): Promise<boolean> {
  try {
    await workspace.createRemote(url, token);
  } catch (err) {
    console.error("remote connect failed:", err);
    notifications.error("Remote connection failed");
    return false;
  }
  workspace.activateRemote();
  workspace.needsLogin = false;
  device.setRemote(url, token);
  await app.init();
  // Fire-and-forget: a denied/unsupported push permission must not block boot.
  void registerPush();
  return true;
}
