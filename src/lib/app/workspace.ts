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
import { editorStore } from "$lib/features/editor/store.svelte";
import { explorerStore } from "$lib/features/explorer/store.svelte";
import { paneStore } from "$lib/features/panes/store.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { confirmDialog } from "$lib/shared/components/confirm.svelte";
import { t } from "$lib/i18n/index.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { device, type BoiteEntry } from "$lib/features/settings/device.svelte";
import { registerPush } from "$lib/features/push/api";
import { parkedLocal } from "$lib/backend/tauri/parked";
import { environments } from "$lib/backend/environment/registry.svelte";
import { applyControlEvent } from "./control-events";

/**
 * Bring up every environment this device keeps connected beside the workspace
 * on screen, and give the registry somewhere to deliver what they push.
 *
 * Called from both boots and again after anything that moves the active boite:
 * the registry excludes whichever environment is the active workspace, since
 * that one is owned here.
 */
function superviseEnvironments(): void {
  environments.onControl = (envId, ev) => applyControlEvent(app, ev, envId);
  environments.start();
  environments.reconcile();
}

/** The picker toggled an environment, or one was added or removed. */
export function refreshEnvironments(): void {
  environments.reconcile();
}

// In a browser/PWA the only backend is the server that served this page.
export function defaultRemoteWsUrl(): string {
  if (typeof location === "undefined") return "";
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

// Drop every workspace-scoped store so init() re-hydrates from the new backend
// instead of mixing two workspaces.
//
// The last three were missing from this list, and all three are keyed by paths
// and ids the new machine does not share: an open buffer saved after the switch
// wrote the previous machine's bytes to that path on this one, a cached listing
// described a folder nobody was connected to any more, and a panel pane kept a
// projectId out of a project list that no longer exists.
//
// Ordered before app.reset() because that one empties the project list these
// stores are read against; a reset that has to ask which project owns a path
// has to run while there is still an answer.
function resetStores() {
  settings.reset();
  todos.reset();
  approvals.reset();
  platform.reset();
  resetShellCache();
  gitStore.reset();
  editorStore.reset();
  explorerStore.reset();
  paneStore.reset();
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

/**
 * The one place a switch can still be called off.
 *
 * PTYs are not the reason any more: local ones are detached, kept alive and
 * buffering, and reattach on the way back. Open buffers are. `resetStores()`
 * drops every one of them, and it cannot flush them first: `connectBoite`
 * awaits `createRemote()` before `adoptRemote()`, so by the time the reset runs
 * `backendForPath()` already answers as the machine being switched TO, and a
 * save would write one machine's bytes to the other's disk. That is the
 * overwrite `editorStore.reset()` exists to prevent, so the only safe place to
 * stop is here, before any of it starts.
 *
 * Silent when nothing is dirty, which is the normal switch.
 */
async function confirmLeaveWorkspace(): Promise<boolean> {
  const dirty = editorStore.buffers.filter((b) => editorStore.isDirty(b)).length;
  if (dirty === 0) return true;
  return confirmDialog.ask({
    title: t("workspace.leaveDirtyTitle"),
    message:
      dirty === 1
        ? t("workspace.leaveDirtyOne")
        : t("workspace.leaveDirtyMany", { count: dirty }),
    confirmLabel: t("workspace.leaveDirtyConfirm"),
  });
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
//
// That skip is load-bearing rather than an economy: paneStore.reset() removes
// the saved layout, so a boot that reset first would delete the very tree
// syncWithThreads is about to restore. `app.ready` is the flag on every switch
// path and is false until init() has run, which is what keeps the three boot
// callers below passing a literal false.
async function connectBoite(
  entry: BoiteEntry,
  reset: boolean,
  mode: "remote" | "dynamic" = "remote",
  keepUnreachable = false,
): Promise<ConnectAttempt> {
  // A dial the user is watching outranks a background graft waiting on a boite.
  disarmGraft();
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
  superviseEnvironments();
}

// Land on the local side, grafting the active boite onto it when the dynamic
// preference is on.
//
// The local workspace never waits for the boite. It used to: the dial was
// awaited before the stores were hydrated, so a boite that was off held the app
// on an empty shell for the twelve seconds of the connect timeout, which reads
// as a machine that reset itself. The graft is asynchronous now and lands
// through `graftRemote` whenever the socket comes up, minutes later if that is
// what it takes.
async function initLocalSide(reset: boolean): Promise<void> {
  // Whatever this init decides replaces the one a previous init armed.
  disarmGraft();
  const wantsGraft = device.dynamicMode && hasTauri() && device.active !== null;
  // Reuse a live socket (e.g. coming back from pure remote): nothing to wait
  // for, so the graft is part of this init rather than deferred.
  if (wantsGraft && workspace.remoteBackend) {
    if (reset) {
      await tearDownTerminals();
      resetStores();
    }
    workspace.activateDynamic();
    await app.init();
    restoreParkedStatuses();
    superviseEnvironments();
    return;
  }
  if (reset) {
    await tearDownTerminals();
    resetStores();
  }
  workspace.activateLocal();
  await app.init();
  restoreParkedStatuses();
  superviseEnvironments();
  if (wantsGraft && device.active) void dialAndGraft(device.active);
}

// Dial a boite for dynamic mode without anything waiting on it. The socket is
// kept on failure so its backoff loop owns the retrying, and the graft is armed
// on the connection instead: a boite booted after the app still shows up, with
// no toast and no button to press. Only a failure that leaves no socket (a
// refused token, a URL nothing can dial) ends here.
async function dialAndGraft(entry: BoiteEntry): Promise<void> {
  disarmGraft();
  try {
    await workspace.createRemote(entry.url, entry.token, true);
  } catch (err) {
    logger.error("workspace", "dynamic dial failed", err);
    if (workspace.remoteBackend) armGraft(entry);
    return;
  }
  await graftRemote(entry);
}

// At most one armed graft: toggling dynamic mode off and on again re-dials, and
// two watchers would graft the same boite twice.
let armedGraft: (() => void) | null = null;

function disarmGraft(): void {
  armedGraft?.();
  armedGraft = null;
}

// One-shot: graft as soon as the backoff loop lands the link.
function armGraft(entry: BoiteEntry): void {
  const off = workspace.onConnection((state) => {
    if (state !== "connected") return;
    disarmGraft();
    void graftRemote(entry).catch((err) => {
      logger.error("workspace", "deferred graft failed", err);
    });
  });
  armedGraft = off;
}

// Merge a boite into the local workspace that is already running. Unlike
// adoptRemote this resets no store, remounts no terminal and re-inits nothing:
// the local rows, the live PTYs and the current selection all survive, and only
// the boite's half is added.
async function graftRemote(entry: BoiteEntry): Promise<void> {
  // The world can move while a socket dials. A switch to pure remote, another
  // boite picked, dynamic mode turned back off: grafting then would relabel a
  // workspace nobody asked about.
  if (!device.dynamicMode || workspace.mode !== "local") return;
  if (device.active?.id !== entry.id || !workspace.remoteBackend) return;
  workspace.activateDynamic();
  workspace.setActiveBoite(entry.id);
  // Seed the label/color from the device cache; fetchAndApplyMeta refreshes it.
  workspace.info = {
    name: entry.name || null,
    color: entry.color || null,
    version: entry.version || null,
  };
  await app.attachRemote();
  // Same reason as adoptRemote: the dock's rows live in the half being grafted,
  // and the socket only says that they changed, never what they are.
  void approvals.reload();
  void fetchAndApplyMeta();
  // Fire-and-forget: this only subscribes an already-granted permission, so it
  // costs nothing and prompts for nothing.
  void registerPush();
  superviseEnvironments();
}

// Flip the dynamic-mode preference. Applies immediately when sitting on the
// local side (graft or ungraft the boite); a pure remote workspace is left
// alone — the preference kicks in on the next return to local.
export async function setDynamicMode(on: boolean): Promise<void> {
  if (device.dynamicMode === on) return;
  // Grafting or ungrafting the boite re-inits the local side, which resets the
  // stores: the toggle costs the open buffers as surely as the picker does.
  // Asked before the preference is written, so a refusal leaves the switch off.
  if (hasTauri() && workspace.mode !== "remote" && app.ready) {
    if (!(await confirmLeaveWorkspace())) return;
  }
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
  // Leaving a boite drops its open buffers exactly as leaving local does. The
  // guard used to be on one direction only, back when it was about local PTYs.
  if (!(await confirmLeaveWorkspace())) return false;
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
  if (!(await confirmLeaveWorkspace())) return false;
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
  superviseEnvironments();
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
  if (!(await confirmLeaveWorkspace())) return { outcome: "unreachable", detail: "" };
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
