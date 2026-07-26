import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { hasTauri } from "$lib/backend/env";
import { notifications } from "$lib/features/notifications/store.svelte";

// The download runs on its own, in silence, the moment a release is found. By
// the time the user sees "restart to update" the bytes are already on disk, so
// the click only swaps files and relaunches. That — not compression — is what
// makes an in-app update feel instant.
const FIRST_CHECK_DELAY_MS = 8_000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

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

  /** Desktop boot hook. Idempotent; returns a teardown for the caller's onMount. */
  start(): () => void {
    if (!hasTauri()) return () => {};
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

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(false), RECHECK_INTERVAL_MS);
  }

  private async run(manual: boolean): Promise<void> {
    if (!hasTauri() || this.inFlight) return;
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
        if (manual) notifications.success("Boite is up to date");
        return;
      }
      await this.download(update);
    } catch (err) {
      const message = messageOf(err);
      // A background check fails on any offline moment, an unreachable endpoint,
      // or a build whose signing key was never configured. None of that is worth
      // interrupting the user over; the settings card still shows it.
      this.status = { kind: "error", message };
      console.error("[updater]", message);
      if (manual) notifications.error(`Update check failed: ${message}`);
    } finally {
      this.inFlight = false;
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
   */
  async install(): Promise<void> {
    const update = this.pending;
    if (!update || this.status.kind !== "ready") return;
    this.status = { kind: "installing" };
    try {
      await update.install();
      await relaunch();
    } catch (err) {
      const message = messageOf(err);
      this.status = { kind: "error", message };
      console.error("[updater] install failed:", message);
      notifications.error(`Update failed: ${message}`);
    }
  }
}

export const updater = new UpdaterStore();
