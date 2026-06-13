import { tick } from "svelte";
import { workspace } from "$lib/backend";
import { app } from "./store.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { platform } from "$lib/storage/platform.svelte";
import { resetShellCache } from "$lib/storage/shell";
import { gitStore } from "$lib/features/git/store.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { confirmDialog } from "$lib/shared/components/confirm.svelte";

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
  if (workspace.mode === "local") return true;
  await tearDownTerminals();
  resetStores();
  workspace.activateLocal();
  await app.init();
  notifications.success("Back to local workspace");
  return true;
}
