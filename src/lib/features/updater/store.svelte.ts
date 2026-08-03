import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { hasTauri } from "$lib/backend/env";
import { notifications } from "$lib/features/notifications/store.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { t } from "$lib/i18n/index.svelte";
import { dropResumePlan, prepareForInstall, restoreThreads } from "./restart";

// The download runs on its own, in silence, the moment a release is found. By
// the time the user sees "restart to update" the bytes are already on disk, so
// the click only swaps files and relaunches. That — not compression — is what
// makes an in-app update feel instant.
const FIRST_CHECK_DELAY_MS = 8_000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
// How stale an answer has to be before opening the About tab asks again.
const OPEN_CHECK_FLOOR_MS = 30_000;

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "downloading"; version: string; received: number; total: number | null }
  | { kind: "ready"; version: string; notes: string | null }
  | { kind: "installing" }
  | { kind: "error"; message: string };

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err);
}

class UpdaterStore {
  status = $state<UpdateStatus>({ kind: "idle" });

  // The handle owning the downloaded payload. Not reactive: it is a resource,
  // and dropping it before install() would strand the bytes on disk.
  private pending: Update | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private lastCheckAt = 0;
  // The restart confirmation is an await, and the status stays "ready" across
  // it, so a second click on "Restart now" used to open a second dialog behind
  // the first and stop every thread twice.
  private preparing = false;

  get busy(): boolean {
    const k = this.status.kind;
    return k === "checking" || k === "downloading" || k === "installing";
  }

  get readyVersion(): string | null {
    return this.status.kind === "ready" ? this.status.version : null;
  }

  /** Progress in [0,1], or null while the server withheld a content length. */
  get progress(): number | null {
    if (this.status.kind !== "downloading") return null;
    const { received, total } = this.status;
    if (!total || total <= 0) return null;
    return Math.min(1, received / total);
  }

  // A dev build has no bundle to swap: the binary sits in target/debug and the
  // release the endpoint advertises would be installed over nothing sensible.
  // Nothing about the updater should run outside a packaged app.
  get enabled(): boolean {
    return hasTauri() && !import.meta.env.DEV;
  }

  /** Desktop boot hook. Idempotent; returns a teardown for the caller's onMount. */
  start(): () => void {
    if (!this.enabled) return () => {};
    const first = setTimeout(() => void this.run(false), FIRST_CHECK_DELAY_MS);
    return () => {
      clearTimeout(first);
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    };
  }

  /** User pressed "Check for updates": failures are worth showing here. */
  async checkNow(): Promise<void> {
    await this.run(true);
  }

  /**
   * Opening the About tab checks, the way opening Chrome's about page does.
   *
   * Silent: this is not a button press, so an offline moment belongs on the card
   * and nowhere else. The floor is what keeps clicking between tabs from firing
   * a network check each time — the answer cannot have changed in half a minute,
   * and the background schedule is still the thing that finds a release.
   */
  checkOnOpen(): void {
    if (!this.enabled) return;
    if (Date.now() - this.lastCheckAt < OPEN_CHECK_FLOOR_MS) return;
    void this.run(false);
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(false), RECHECK_INTERVAL_MS);
  }

  private async run(manual: boolean): Promise<void> {
    if (!this.enabled || this.inFlight) return;
    // Something is already downloaded and waiting: re-checking would only
    // discard it for the same release.
    if (this.status.kind === "ready" || this.status.kind === "installing") {
      this.schedule();
      return;
    }

    this.inFlight = true;
    this.status = { kind: "checking" };
    try {
      const update = await check();
      if (!update) {
        this.status = { kind: "current" };
        if (manual) notifications.success(t("updater.upToDate"));
        return;
      }
      await this.download(update);
    } catch (err) {
      const message = messageOf(err);
      // A background check fails on any offline moment, an unreachable endpoint,
      // or a build whose signing key was never configured. None of that is worth
      // interrupting the user over; the settings card still shows it.
      this.status = { kind: "error", message };
      logger.error("updater", "update check failed", message);
      if (manual) {
        notifications.error(t("updater.checkFailed", { error: message }));
      }
    } finally {
      this.inFlight = false;
      this.lastCheckAt = Date.now();
      this.schedule();
    }
  }

  private async download(update: Update): Promise<void> {
    let received = 0;
    let total: number | null = null;
    this.status = { kind: "downloading", version: update.version, received: 0, total: null };

    await update.download((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? null;
      } else if (event.event === "Progress") {
        received += event.data.chunkLength;
      }
      if (this.status.kind === "downloading") {
        this.status = { kind: "downloading", version: update.version, received, total };
      }
    });

    this.pending = update;
    this.status = { kind: "ready", version: update.version, notes: update.body ?? null };
  }

  /**
   * Swap the files in and come back up. On Windows the NSIS installer is what
   * relaunches us — the process is gone before `relaunch()` is reached, so the
   * line below only ever runs on macOS and Linux.
   *
   * Nothing here is silent: the restart kills every local PTY, so the user gets
   * a say first and the threads that were alive are noted for the boot on the
   * other side.
   */
  async install(): Promise<void> {
    const update = this.pending;
    if (!update || this.status.kind !== "ready" || this.preparing) return;
    const version = this.status.version;

    // The confirm dialog is a real await: re-check that nothing changed the
    // status while it was open before committing to the swap.
    this.preparing = true;
    let stopped: string[] | null;
    try {
      stopped = await prepareForInstall(version);
    } finally {
      this.preparing = false;
    }
    if (stopped === null) return;
    if (this.status.kind !== "ready") {
      restoreThreads(stopped);
      dropResumePlan();
      return;
    }

    this.status = { kind: "installing" };
    try {
      await update.install();
      await relaunch();
    } catch (err) {
      const message = messageOf(err);
      logger.error("updater", "install failed", message);
      // The payload handle is spent once install() has thrown; a retry has to
      // start from a fresh check, and the threads we stopped for an update that
      // never happened come straight back.
      this.pending = null;
      dropResumePlan();
      const restored = restoreThreads(stopped);
      this.status = { kind: "error", message };
      notifications.error(
        restored > 0
          ? t("updater.installFailedRestored", { error: message })
          : t("updater.installFailed", { error: message }),
      );
      this.schedule();
    }
  }
}

export const updater = new UpdaterStore();
