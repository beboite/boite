import { app } from "$lib/app/store.svelte";
import { explorerSearch } from "$lib/features/explorer/api";
import { editorStore } from "$lib/features/editor/store.svelte";
import { revealEditor } from "$lib/features/editor/reveal";
import { threadCwd } from "$lib/features/thread/cwd";
import { logger } from "$lib/shared/services/logger.svelte";
import { FILE_SEARCH_LIMIT } from "./modes";
import type { PaletteCommand } from "./registry";

/**
 * Where a file search starts.
 *
 * The active thread's own folder, which is its worktree when it has one: a
 * thread is a process in a directory, and searching the project folder while
 * the agent works in a checkout of it would answer with the wrong copies of
 * every file. Falls back to the selected project for a window with no thread
 * open, and answers nothing rather than searching a machine's root.
 */
export function fileSearchRoot(): string | null {
  const thread = app.activeThread;
  const project = app.projects.find(
    (p) => p.id === (thread?.projectId ?? app.currentProjectId),
  );
  if (!project) return null;
  return thread ? threadCwd(thread, project) : project.cwd;
}

/** The tail of a path, and the folders above it, for the row's two lines. */
export function splitPath(path: string, root: string): { name: string; where: string } {
  const clean = path.replace(/\\/g, "/");
  const name = clean.slice(clean.lastIndexOf("/") + 1);
  const rootClean = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const relative = clean.startsWith(rootClean + "/")
    ? clean.slice(rootClean.length + 1)
    : clean;
  const where = relative.slice(0, Math.max(0, relative.lastIndexOf("/")));
  return { name, where };
}

/**
 * Files matching a term, as palette rows.
 *
 * Not re-scored here. The backend already decided what matches and in which
 * order, and running the palette's own fuzzy matcher over the answer would drop
 * hits it found by a rule this one does not have.
 */
export async function searchFileCommands(term: string): Promise<PaletteCommand[]> {
  const root = fileSearchRoot();
  if (!root) return [];
  let hits;
  try {
    hits = await explorerSearch(root, term, FILE_SEARCH_LIMIT);
  } catch (err) {
    logger.warn("palette", "file search failed", err);
    return [];
  }
  return hits
    .filter((hit) => !hit.isDir)
    .map((hit) => {
      const { name, where } = splitPath(hit.path, root);
      return {
        id: `file:${hit.path}`,
        section: "files" as const,
        label: name,
        hint: where || undefined,
        run: async () => {
          await editorStore.open(hit.path);
          revealEditor();
        },
      } satisfies PaletteCommand;
    });
}
