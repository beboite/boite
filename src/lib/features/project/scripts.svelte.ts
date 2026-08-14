import { backendForPath } from "$lib/backend";
import { logger } from "$lib/shared/services/logger.svelte";
import { joinPath } from "./path";
import { detectManager, parsePackageScripts, type ProjectScript } from "./scripts";

/**
 * What each project's `package.json` declares, read once and kept.
 *
 * Keyed by folder rather than by project id: two projects opened on the same
 * checkout are the same list, and a project whose folder moved is a different
 * one. Nothing is persisted, because the file on disk is the truth and it can
 * change between two launches of the app.
 *
 * The read is a `readDir` for the lockfile plus one `readTextFile`, which is
 * why it happens when a project is selected rather than for every project in
 * the sidebar at boot.
 */
class ProjectScripts {
  private byFolder = $state<Record<string, ProjectScript[]>>({});
  // The promise, not just the folder name: a second caller has to be able to
  // wait for the read that is already running rather than be told it is done.
  private inFlight = new Map<string, Promise<void>>();

  /** What this folder declares, or an empty list until the read lands. */
  forFolder(folder: string | null): ProjectScript[] {
    if (!folder) return [];
    return this.byFolder[folder] ?? [];
  }

  /**
   * Reads a folder, at most once at a time.
   *
   * `force` is for the case the file changed under the app: the palette asks
   * for it on open, which is the moment somebody is about to look at the list.
   *
   * A read already running is joined rather than skipped, and a forced call
   * that lands during one queues its own read behind it. Returning early there
   * would drop the `force` on the floor: the caller rebuilds its list as soon
   * as this resolves, so a palette closed and reopened inside one read window
   * would show the previous answer with nothing scheduled to correct it.
   */
  async ensure(folder: string | null, force = false): Promise<void> {
    if (!folder) return;
    const running = this.inFlight.get(folder);
    if (running) {
      await running;
      if (!force) return;
      // Another forced caller may have queued the re-read while this one
      // waited. Joining it answers the same thing for one file read.
      const queued = this.inFlight.get(folder);
      if (queued) return queued;
    } else if (!force && this.byFolder[folder] !== undefined) {
      return;
    }
    const read = this.read(folder);
    this.inFlight.set(folder, read);
    try {
      await read;
    } finally {
      this.inFlight.delete(folder);
    }
  }

  private async read(folder: string): Promise<void> {
    try {
      const backend = backendForPath(folder);
      const entries = await backend.explorer.readDir(folder);
      const names = entries.map((e) => e.name);
      if (!names.includes("package.json")) {
        this.byFolder[folder] = [];
        return;
      }
      // joinPath rather than a literal `/`: a Windows folder keeps its
      // backslashes, and a path stored with a trailing separator does not turn
      // into `D:\repo\/package.json` on the way to the backend.
      const file = await backend.editor.readTextFile(joinPath(folder, "package.json"));
      this.byFolder[folder] = parsePackageScripts(file.content, detectManager(names));
    } catch (err) {
      // A folder that is gone, unreadable or on a boite that just dropped. The
      // list stays empty and the palette simply offers nothing, which is what
      // it did before this existed.
      logger.debug("project", "could not read scripts", err);
      this.byFolder[folder] = [];
    }
  }

  /**
   * A workspace switch replaces every project, and every folder with it.
   *
   * Keyed by absolute path, which is exactly what two machines can spell the
   * same way and mean different things by, so this has to run on the switch
   * rather than be left to expire: `resetStores()` in app/workspace.ts calls it.
   */
  reset(): void {
    this.byFolder = {};
  }
}

export const projectScripts = new ProjectScripts();
