import { tick } from "svelte";
import { backend, workspace } from "$lib/backend";
import { hasTauri } from "$lib/backend/env";
import { connectFailReason } from "$lib/backend/remote/socket";
import { app } from "./store.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { platform } from "$lib/storage/platform.svelte";
import { resetShellCache } from "$lib/storage/shell";
import { gitStore } from "$lib/features/git/store.svelte";
import { todos } from "$lib/features/todo/store.svelte";
import { approvals } from "$lib/features/approvals/store.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { device, type BoiteEntry } from "$lib/features/settings/device.svelte";
import { registerPush } from "$lib/features/push/api";
import { parkedLocal } from "$lib/backend/tauri/parked";

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
  todos.reset();
  approvals.reset();
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
  // The boite owns its identity; in dynamic mode backend() is local, so ask
  // the remote connection directly.
  const meta = workspace.remoteBackend?.meta ?? backend().meta;
  if (!meta) return;
  try {
    const info = await meta.get();
    workspace.info = { name: info.name, color: info.color, version: info.version };
    if (workspace.activeBoiteId) {
      device.updateBoite(workspace.activeBoiteId, {
        name: info.name ?? "",
        color: info.color ?? "",
        // A boite too old to report one leaves the cache empty rather than
        // keeping the version it had before: this read is what it runs now.
        version: info.version ?? "",
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

/**
 * How a dial ended. Only `auth` is something a login form can fix; the others
 * mean the boite was never reached, and the answer to that is to keep trying
 * rather than to ask for the token again.
 *
 * `detail` is the transport's own words (`connect timeout`, the server's auth
 * error). Diagnostic, never translated, and shown as such.
 */
export interface ConnectAttempt {
  outcome: "ok" | "auth" | "unreachable" | "timeout" | "url";
  detail: string;
}

// Connect to a saved boite and initialize the app against it. `reset` tears the
// current workspace down first (store reset + terminal remount); it is skipped
// at boot, where nothing is initialized yet. `mode` picks how the connection
// lands: "remote" replaces the workspace (classic switch), "dynamic" grafts
// the boite onto the local one (the picker still shows "Local").
async function connectBoite(
  entry: BoiteEntry,
  reset: boolean,
  mode: "remote" | "dynamic" = "remote",
  keepUnreachable = false,
): Promise<ConnectAttempt> {
  try {
    await workspace.createRemote(entry.url, entry.token, keepUnreachable);
  } catch (err) {
    logger.error("workspace", "remote connect failed", err);
    // A kept socket means the connection banner is about to say the link is
    // down, and a red toast on top of it says the same thing twice.
    if (!keepUnreachable) notifications.error("Remote connection failed");
    return {
      outcome: connectFailReason(err),
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  await adoptRemote(entry, reset, mode);
  return { outcome: "ok", detail: "" };
}

// The half of the connect that runs once the socket is up: swap the workspace
// over and initialize the app against it. Split out because a boot that started
// with no network runs it later, when the backoff loop finally lands.
async function adoptRemote(
  entry: BoiteEntry,
  reset: boolean,
  mode: "remote" | "dynamic",
): Promise<void> {
  if (reset) {
    await tearDownTerminals();
    resetStores();
  }
  if (mode === "dynamic") workspace.activateDynamic();
  else workspace.activateRemote();
  workspace.setActiveBoite(entry.id);
  // Seed the label/color from the device cache so the pill shows this boite's
  // identity immediately; fetchAndApplyMeta refreshes it from the server.
  workspace.info = {
    name: entry.name || null,
    color: entry.color || null,
    version: entry.version || null,
  };
  workspace.needsLogin = false;
  device.setActive(entry.id);
  await app.init();
  // The dock's rows live in the workspace being adopted, and nothing else asks
  // for them on this path: the desktop's boot reads them once in `+layout`,
  // which a PWA never reaches, and the socket only says *that* they changed.
  // Without this a request opened while the phone was closed stayed invisible
  // until an agent happened to open a second one.
  void approvals.reload();
  // Dynamic keeps the local side alive: repaint the parked local dots.
  if (workspace.isDynamic) restoreParkedStatuses();
  void fetchAndApplyMeta();
  // Fire-and-forget: this only subscribes an already-granted permission, so it
  // costs nothing and prompts for nothing.
  void registerPush();
}

// Land on the local side, grafting the active boite onto it when the dynamic
// preference is on (and degrading to plain local when it is unreachable).
async function initLocalSide(reset: boolean): Promise<void> {
  if (device.dynamicMode && hasTauri() && device.active) {
    // Reuse a live socket (e.g. coming back from pure remote); otherwise dial.
    if (workspace.remoteBackend) {
      if (reset) {
        await tearDownTerminals();
        resetStores();
      }
      workspace.activateDynamic();
      await app.init();
      restoreParkedStatuses();
      return;
    }
    const res = await connectBoite(device.active, reset, "dynamic");
    if (res.outcome === "ok") return;
    notifications.error("Boite unreachable, local only");
  }
  if (reset) {
    await tearDownTerminals();
    resetStores();
  }
  workspace.activateLocal();
  await app.init();
  restoreParkedStatuses();
}

// Flip the dynamic-mode preference. Applies immediately when sitting on the
// local side (graft or ungraft the boite); a pure remote workspace is left
// alone — the preference kicks in on the next return to local.
export async function setDynamicMode(on: boolean): Promise<void> {
  if (device.dynamicMode === on) return;
  device.setDynamicMode(on);
  if (!hasTauri()) return;
  if (workspace.mode === "remote") return;
  await initLocalSide(app.ready);
}

// Desktop boot: land on the local side (dynamic graft included when enabled).
export async function bootDesktopWorkspace(): Promise<void> {
  await initLocalSide(false);
}

export async function switchToLocal(): Promise<boolean> {
  // No local backend in a browser/PWA: there is nowhere to switch to.
  if (!hasTauri()) return false;
  // Dynamic counts as the local side: the picker's "Local" row is a no-op.
  if (workspace.mode !== "remote") return true;
  await initLocalSide(true);
  notifications.success("Back to local workspace");
  return true;
}

// Threads reload from SQLite as idle (ready/running are never persisted), but
// their PTYs were only parked, not killed. Repaint the last-known dot colour so
// the picker shows them connected; clicking one reattaches and resumes live
// status. statusEngine skips parked threads, so this colour sticks until then.
function restoreParkedStatuses() {
  for (const [id, status] of parkedLocal) {
    app.setThreadStatus(id, status);
  }
}

// Switch to an already-saved boite (pure remote, classic behavior). No-op when
// it is already the active, connected workspace.
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
  return (await connectBoite(entry, app.ready, "remote")).outcome === "ok";
}

// PWA boot: connect to the last-active saved boite. A boite that cannot be
// reached is not a login problem, so the app lands on the connection banner with
// its socket still trying; only a refused token raises the gate.
export async function bootRemoteWorkspace(): Promise<boolean> {
  const entry = device.active ?? device.boites[0] ?? null;
  if (!entry) {
    workspace.needsLogin = true;
    return false;
  }
  const res = await connectBoite(entry, false, "remote", true);
  if (res.outcome === "ok") return true;
  if (res.outcome === "auth" || !workspace.remoteBackend) {
    workspace.needsLogin = true;
    return false;
  }
  // Present the boite as the active workspace even though nothing is up yet: the
  // banner explains the state, and the cached name/color keep the chrome honest
  // about which boite is being waited on.
  workspace.activateRemote();
  workspace.setActiveBoite(entry.id);
  workspace.info = {
    name: entry.name || null,
    color: entry.color || null,
    version: entry.version || null,
  };
  device.setActive(entry.id);
  finishBootWhenReachable(entry);
  return false;
}

// One-shot: the socket owns the retrying, so all the app has to do is be ready to
// finish the boot it could not finish at launch.
function finishBootWhenReachable(entry: BoiteEntry): void {
  const off = workspace.onConnection((state) => {
    if (state !== "connected") return;
    off();
    // The link that came up may belong to a different boite: the picker and the
    // login form can both replace the socket while this is armed, and adopting
    // the boite this boot was about would then relabel someone else's workspace.
    if (workspace.activeBoiteId !== entry.id) return;
    void adoptRemote(entry, false, "remote").catch((err) => {
      logger.error("workspace", "deferred remote boot failed", err);
    });
  });
}

// Retry button in the connection banner. The live socket is preferred: it still
// holds every attached thread's byte offset, so a reconnect costs the delta
// rather than a full scrollback replay. A socket that is gone means dialling
// again from the saved entry.
export async function retryConnection(): Promise<void> {
  if (workspace.retryRemote()) return;
  const entry =
    (workspace.activeBoiteId ? device.getBoite(workspace.activeBoiteId) : null) ??
    device.active;
  if (!entry) return;
  await connectBoite(
    entry,
    app.ready,
    workspace.isDynamic ? "dynamic" : "remote",
    true,
  );
}

// Register a new boite (or re-pair an existing URL) and connect to it, reporting
// which of the failures it was. The login screen needs that: a refused token, a
// hostname that does not resolve, a TLS handshake the browser rejected and a
// connect timeout used to read as the same sentence about the token.
export async function connectAndInitDetailed(
  url: string,
  token: string,
): Promise<ConnectAttempt> {
  if (!(await confirmLeaveLocal())) return { outcome: "unreachable", detail: "" };
  // Whether this URL was already known decides what a failure costs. A brand new
  // one that never connected is rolled back out of the list: it used to be saved
  // before the dial and left marked active with its token, and on a PWA the only
  // delete button for it sits behind the login gate it just put you behind.
  const known = device.boites.some((b) => b.url === url);
  const entry = device.addBoite(url, token);
  const res = await connectBoite(entry, app.ready);
  if (res.outcome !== "ok" && !known) device.removeBoite(entry.id);
  return res;
}

// Used by the "add boite" action in the workspace picker, which has a toast for a
// failure rather than a place to explain one.
export async function connectAndInit(url: string, token: string): Promise<boolean> {
  return (await connectAndInitDetailed(url, token)).outcome === "ok";
}

// Push a cosmetic name/color change to the active boite. The server persists it
// and broadcasts workspace.info, so every other connected device updates live.
export async function setActiveBoiteInfo(patch: {
  name?: string | null;
  color?: string | null;
}): Promise<void> {
  const meta = workspace.remoteBackend?.meta ?? backend().meta;
  if (!meta) return;
  try {
    const res = await meta.set(patch);
    workspace.info = { name: res.name, color: res.color, version: res.version };
    if (workspace.activeBoiteId) {
      device.updateBoite(workspace.activeBoiteId, {
        name: res.name ?? "",
        color: res.color ?? "",
      });
    }
  } catch (err) {
    logger.error("workspace", "setInfo failed", err);
    notifications.error("Update failed");
  }
}
