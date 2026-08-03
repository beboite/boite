import { app } from "$lib/app/store.svelte";

/**
 * Which project a file belongs to, decided by where it is on disk.
 *
 * Not "whichever project was selected when it was opened": the explorer, the
 * git panel and an agent's own request can all name a path while the selection
 * is elsewhere, and a buffer filed under the wrong project is worse than one
 * filed under none — it would appear in a strip whose files it has nothing to
 * do with.
 *
 * Longest prefix wins, so a project nested inside another one takes its own
 * files, and a thread's worktree is matched too since it lives under the
 * project directory.
 */
export function projectOwning(path: string): string | null {
  const target = normalize(path);
  let bestId: string | null = null;
  let bestLen = -1;
  for (const project of app.projects) {
    for (const root of [project.cwd, project.gitRoot ?? null]) {
      if (!root) continue;
      const prefix = normalize(root);
      if (!under(target, prefix)) continue;
      if (prefix.length > bestLen) {
        bestLen = prefix.length;
        bestId = project.id;
      }
    }
  }
  if (bestId) return bestId;
  // A thread can run in a worktree the project does not contain, and a file
  // opened from there is still that project's.
  for (const thread of app.threads) {
    if (!thread.worktreePath) continue;
    if (under(target, normalize(thread.worktreePath))) return thread.projectId;
  }
  return null;
}

/** Backslashes to forward, trailing separator off, so prefixes compare. */
function normalize(p: string): string {
  const slashed = p.replaceAll("\\", "/");
  return slashed.length > 1 && slashed.endsWith("/") ? slashed.slice(0, -1) : slashed;
}

// Separator-aware: `/a/bc` must not count as living under `/a/b`.
function under(target: string, prefix: string): boolean {
  return target === prefix || target.startsWith(prefix + "/");
}
