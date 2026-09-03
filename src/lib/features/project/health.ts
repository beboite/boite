import type { FolderState } from "$lib/backend/types";
import type { MessageKey } from "$lib/i18n/messages";

/**
 * What is wrong with a project, decided once for the whole dashboard.
 *
 * Eight cards used to answer that question one at a time, each from whatever
 * git had said to it: a folder that had been moved printed the same OS error
 * three times, in three shapes, and nothing on the page said the folder was
 * gone or offered to do anything about it. The page asks once now, at the top,
 * and the cards under it read this instead of the failure.
 *
 * No runes and no Svelte import, so both halves are testable without mounting
 * a dashboard: the mapping from a raw error to copy, and the mapping from the
 * two probes to a state.
 */
export type ProjectHealth = "checking" | "missing" | "notRepo" | "ok";

/**
 * The failures worth their own sentence. `unknown` is the honest answer for
 * anything else, and it is what keeps a stderr line out of the page: unmapped
 * text goes behind a disclosure rather than into a paragraph.
 */
export type GitFailure = "notARepo" | "pathMissing" | "detached" | "unknown";

/**
 * Which of the four an error text is.
 *
 * Matched on the parts that are the same in every language. A Windows
 * `canonicalize` failure carries the OS message in the user's own locale and
 * the `(os error 3)` tail in none of them, so the tail is what is read; the
 * `invalid path:` prefix is Boite's own (`scope.rs`) and travels with it.
 */
export function gitFailure(text: string): GitFailure {
  const lower = text.toLowerCase();
  if (
    lower.includes("os error 2") ||
    lower.includes("os error 3") ||
    lower.includes("invalid path") ||
    lower.includes("no such file or directory") ||
    lower.includes("cannot find the path") ||
    lower.includes("cannot find the file")
  ) {
    return "pathMissing";
  }
  if (
    lower.includes("not a git repository") ||
    lower.includes("not a repository") ||
    lower.includes("does not appear to be a git repository")
  ) {
    return "notARepo";
  }
  if (lower.includes("detached head") || lower.includes("head detached")) {
    return "detached";
  }
  return "unknown";
}

/** The line to print for a failure. `unknown` gets the generic one. */
export function gitFailureKey(kind: GitFailure): MessageKey {
  if (kind === "pathMissing") return "project.folderGone";
  if (kind === "notARepo") return "project.notARepo";
  if (kind === "detached") return "git.detachedHead";
  return "git.readFolderFailed";
}

export interface HealthProbe {
  /** What the folder probe answered, or null while it is still out. */
  folder: FolderState | null;
  /** Whether the git state has settled at least once. */
  gitLoaded: boolean;
  gitIsRepo: boolean;
  /** The last refresh failure, raw, or null. */
  gitError: string | null;
}

/**
 * Missing, not a repository, or fine.
 *
 * `checking` is deliberately not "fine yet": it is what the cards read as
 * ordinary, so nothing blinks out of existence on the way to a verdict. Only a
 * settled answer hides anything.
 *
 * The folder probe decides "missing" on its own, and the git error is read as
 * a second witness: a folder deleted between the probe and the refresh answers
 * `os error 3` before the next probe runs.
 */
export function projectHealth(probe: HealthProbe): ProjectHealth {
  if (probe.folder === "missing") return "missing";
  if (probe.gitError && gitFailure(probe.gitError) === "pathMissing") {
    return "missing";
  }
  if (probe.folder === null) return "checking";
  if (probe.gitError && gitFailure(probe.gitError) === "notARepo") {
    return "notRepo";
  }
  if (!probe.gitLoaded) return "checking";
  return probe.gitIsRepo ? "ok" : "notRepo";
}

/** Whether a card that reads the repository is worth drawing at all. */
export function repoCardsVisible(health: ProjectHealth): boolean {
  return health === "checking" || health === "ok";
}
