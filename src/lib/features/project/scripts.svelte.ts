import { backendForPath } from "$lib/backend";
import { logger } from "$lib/shared/services/logger.svelte";
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
  private inFlight = new Set<string>();

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
   */
  async ensure(folder: string | null, force = false): Promise<void> {
    if (!folder) return;
    if (this.inFlight.has(folder)) return;
    if (!force && this.byFolder[folder] !== undefined) return;
    this.inFlight.add(folder);
    try {
      const backend = backendForPath(folder);
      const entries = await backend.explorer.readDir(folder);
      const names = entries.map((e) => e.name);
      if (!names.includes("package.json")) {
        this.byFolder[folder] = [];
        return;
      }
      const file = await backend.editor.readTextFile(`${folder}/package.json`);
      this.byFolder[folder] = parsePackageScripts(file.content, detectManager(names));
    } catch (err) {
      // A folder that is gone, unreadable or on a boite that just dropped. The
      // list stays empty and the palette simply offers nothing, which is what
      // it did before this existed.
      logger.debug("project", "could not read scripts", err);
      this.byFolder[folder] = [];
    } finally {
      this.inFlight.delete(folder);
    }
  }

  /** A workspace switch replaces every project, and every folder with it. */
  reset(): void {
    this.byFolder = {};
  }
}

export const projectScripts = new ProjectScripts();
