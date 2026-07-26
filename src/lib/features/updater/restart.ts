import { app } from "$lib/app/store.svelte";
import { workspace } from "$lib/backend";
import { editorStore } from "$lib/features/editor/store.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { stopThread } from "$lib/features/thread/api";
import { confirmDialog } from "$lib/shared/components/confirm.svelte";
import { saveThread } from "$lib/storage/db";
import type { Thread } from "$lib/types";

// A local PTY dies with the process that owns it: the master handle lives in
// this app, and on Windows the NSIS installer kills us outright. Nothing can
// carry a running `claude` across that. What can be carried is the session:
// every agent thread that captured a sessionId respawns with `--resume <id>`,
// so the conversation comes back where it was left. This module notes which
// threads were alive, kills them on our terms before the swap, and wakes them
// again on the other side.
//
// Remote threads are untouched: their PTYs live in boite-server, which the
// restart never reaches. They keep running and reattach on their own.
const PLAN_KEY = "boite.updateResume";

// A plan the boot never consumed (install died, machine rebooted into something
// else, user reopened hours later) must not resurrect agents into a context the
// user has moved on from.
const PLAN_TTL_MS = 30 * 60 * 1000;

interface ResumePlan {
  at: number;
  version: string;
  ids: string[];
}

function hasStorage(): boolean {
  return typeof localStorage !== "undefined";
}

// Threads whose PTY this process owns. `clientStatus` is the local backend's
// marker: the server owns runtime state for everything else.
function liveLocalThreads(): Thread[] {
  return app.threads.filter(
    (t) => t.ptyId && workspace.backendFor(t.origin).caps.clientStatus,
  );
}

function armResumePlan(version: string, ids: string[]) {
  if (!hasStorage() || ids.length === 0) return;
  const plan: ResumePlan = { at: Date.now(), version, ids };
  try {
    localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
  } catch (err) {
    console.error("[updater] could not arm the resume plan:", err);
  }
}

function clearResumePlan() {
  if (!hasStorage()) return;
  try {
    localStorage.removeItem(PLAN_KEY);
  } catch {
    // nothing to clear
  }
}

// Read-and-clear: a plan is consumed once, whatever happens next.
function takeResumePlan(): ResumePlan | null {
  if (!hasStorage()) return null;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PLAN_KEY);
  } catch {
    return null;
  }
  clearResumePlan();
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<ResumePlan>;
    if (!Array.isArray(p.ids) || typeof p.at !== "number") return null;
    if (Date.now() - p.at > PLAN_TTL_MS) return null;
    return {
      at: p.at,
      version: typeof p.version === "string" ? p.version : "",
      ids: p.ids.filter((id): id is string => typeof id === "string"),
    };
  } catch {
    return null;
  }
}

function describe(count: number, dirty: number): string {
  const parts: string[] = [];
  if (count > 0) {
    parts.push(
      count === 1
        ? "1 running thread will be stopped and started again after the restart."
        : `${count} running threads will be stopped and started again after the restart.`,
    );
    parts.push(
      "Agents that captured a session resume that conversation; anything else re-runs its command.",
    );
  }
  if (dirty > 0) {
    parts.push(
      dirty === 1
        ? "1 file has unsaved changes and will be lost."
        : `${dirty} files have unsaved changes and will be lost.`,
    );
  }
  return parts.join(" ");
}

/**
 * Everything that must happen before the installer takes over. Returns the ids
 * it stopped, or null when the user backed out — the caller must not install.
 */
export async function prepareForInstall(version: string): Promise<string[] | null> {
  const live = liveLocalThreads();
  const dirty = editorStore.buffers.filter((b) => editorStore.isDirty(b)).length;

  if (live.length > 0 || dirty > 0) {
    const ok = await confirmDialog.ask({
      title: `Restart to install ${version}?`,
      message: describe(live.length, dirty),
      confirmLabel: "Restart and update",
      danger: dirty > 0,
    });
    if (!ok) return null;
  }

  // Titles are written on a 500ms coalescing window; the process is about to
  // end, so force the batch out before it does.
  await app.flushPendingWrites();

  const ids = live.map((t) => t.id);
  // Armed before the kills: if the app dies between here and the installer, the
  // next boot still knows what to bring back.
  armResumePlan(version, ids);

  // The kill itself is what closing a thread does (job-object terminate on
  // Windows, SIGKILL to the process group elsewhere), but doing it here rather
  // than letting the installer yank the process means the DB rows and the plan
  // above are written first — and on macOS/Linux, where install() does not kill
  // our children, it is the only thing that stops an orphaned agent from
  // outliving the app it was attached to.
  await Promise.all(
    ids.map((id) =>
      stopThread(id).catch((err) => {
        console.error("[updater] stopThread failed:", err);
      }),
    ),
  );

  return ids;
}

/** Bring stopped threads back and let the page mount (and so respawn) them. */
export function restoreThreads(ids: string[]): number {
  let restored = 0;
  for (const id of ids) {
    const t = app.threadById(id);
    if (!t || t.ptyId) continue;
    t.status = "idle";
    t.exitCode = null;
    t.autoSlept = false;
    void saveThread({ ...t, args: [...t.args] }).catch((err) => {
      console.error("saveThread failed:", err);
    });
    app.requestActivation(id);
    app.bumpRespawn(id);
    restored++;
  }
  return restored;
}

/** Abandon a plan without acting on it (install failed before the swap). */
export function dropResumePlan() {
  clearResumePlan();
}

/**
 * Boot hook, called once the workspace has loaded its threads. Wakes whatever
 * was running when the update was applied.
 */
export function resumeAfterUpdate() {
  const plan = takeResumePlan();
  if (!plan || plan.ids.length === 0) return;
  const restored = restoreThreads(plan.ids);
  if (restored === 0) return;
  notifications.success(
    restored === 1
      ? "Update applied. Resuming your thread."
      : `Update applied. Resuming ${restored} threads.`,
  );
}
