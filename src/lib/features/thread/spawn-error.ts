import type { MessageKey } from "$lib/i18n/messages";

/**
 * What a failed launch says to the person who asked for it.
 *
 * `PtyManager::spawn` refuses a directory that is not there with
 * `this directory is not there: <path>` (`crates/boite-core/src/pty.rs`), and
 * that sentence used to be written into the terminal as it stood: English, in
 * a French window, inside the one surface where a line of text looks like the
 * program's own output. The backend keeps its wording — it is a bus answer
 * every host reads, and it goes in the log — and the frontend decides what the
 * user reads.
 *
 * No runes and no Svelte import, so the mapping is testable on its own. See
 * `withWorktree` in `./api.ts` for the other half of this failure: a thread
 * whose worktree is gone is given a new one rather than left pointed at it.
 */
export type SpawnFailure = "folderGone" | "notFound" | "denied" | "unknown";

export function spawnFailure(text: string): SpawnFailure {
  const lower = text.toLowerCase();
  if (
    lower.includes("this directory is not there") ||
    lower.includes("no such file or directory") ||
    lower.includes("os error 3") ||
    lower.includes("cannot find the path")
  ) {
    return "folderGone";
  }
  if (
    lower.includes("command not found") ||
    lower.includes("program not found") ||
    lower.includes("os error 2")
  ) {
    return "notFound";
  }
  if (lower.includes("access is denied") || lower.includes("permission denied")) {
    return "denied";
  }
  return "unknown";
}

/** The line written into the terminal instead of the backend's own. */
export function spawnFailureKey(kind: SpawnFailure): MessageKey {
  if (kind === "folderGone") return "terminal.spawnFolderGone";
  if (kind === "notFound") return "terminal.spawnNotFound";
  if (kind === "denied") return "terminal.spawnDenied";
  return "terminal.spawnFailedLine";
}

/** What the pill under a failed terminal offers. */
export function spawnPillKey(kind: SpawnFailure): MessageKey {
  return kind === "folderGone"
    ? "terminal.spawnFolderGonePill"
    : "terminal.spawnFailedRelaunch";
}
