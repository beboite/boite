import type { Project, Thread } from "$lib/types";

type ThreadLike = Pick<Thread, "worktreePath"> | null | undefined;
type ProjectLike = Pick<Project, "cwd" | "gitRoot"> | null | undefined;

/**
 * Where this thread actually runs. A process lives in a directory; a project
 * does not. Everything that resolves a folder for a thread — the PTY, the
 * explorer, the Claude session lookup — goes through here, so a thread in a
 * worktree stops being described by its project's folder.
 */
export function threadCwd(thread: ThreadLike, project: ProjectLike): string | null {
  return thread?.worktreePath ?? project?.cwd ?? null;
}

/**
 * Which repository the git panel operates on for this thread.
 *
 * `gitRoot` answers "the project folder is not itself a repo, the repo is one
 * level down". A worktree is already a repo, so it answers that question
 * first and the nested-repo pick no longer applies to it.
 */
export function threadGitRoot(thread: ThreadLike, project: ProjectLike): string | null {
  return thread?.worktreePath ?? project?.gitRoot ?? project?.cwd ?? null;
}
