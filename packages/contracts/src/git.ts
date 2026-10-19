import type { ProjectId, ThreadId } from './ids';

export type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflict';

/** One path `git status` reports, staged or not, with the numbers `git diff --numstat` gives it. */
export interface GitChange {
  path: string;
  status: GitChangeStatus;
  /** The previous path of a rename or copy. */
  oldPath: string | null;
  staged: boolean;
  /** Null on a binary or untracked file. */
  additions: number | null;
  deletions: number | null;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
}

/** Maximum full name of a Git branch created by Boite, including prefix and collision suffix. */
export const BRANCH_NAME_MAX = 48;

/**
 * One linked worktree of a project's repository, as `worktrees.list` reads it
 * from `git worktree list`: the core's own in its configured storage and any the
 * user added by hand, never the main checkout. What it says is what a removal
 * would lose.
 */
export interface WorktreeEntry {
  /** The directory, in the form of the machine running the core. */
  path: string;
  /** The branch checked out there without `refs/heads/`, null on a detached HEAD. */
  branch: string | null;
  /** `git status` lists something: a modified, staged or untracked file. False when `missing`. */
  dirty: boolean;
  /**
   * HEAD is reachable from no local branch or remote-tracking ref other than
   * the worktree's own branch: removing the worktree and its branch loses
   * those commits. A branch with no commit of its own is not unmerged.
   */
  unmerged: boolean;
  /** Git still lists the worktree but its directory is gone. */
  missing: boolean;
  /**
   * The thread whose working directory is this worktree or a folder inside
   * it, compared without case on Windows. A live thread wins over an archived
   * one; null when no thread stands there.
   */
  threadId: ThreadId | null;
  threadTitle: string | null;
  /** That thread is archived: the worktree can be removed. False when `threadId` is null. */
  threadArchived: boolean;
}

/** Both sides of one file, the working tree against `ref` (HEAD by default). */
export interface GitDiff {
  path: string;
  oldPath: string | null;
  status: GitChangeStatus;
  /** Null when the side does not exist: an added or a deleted file. */
  oldText: string | null;
  newText: string | null;
  binary: boolean;
  /** Either side was cut at `DIFF_MAX_BYTES`. */
  truncated: boolean;
}

export interface GitRpcMethods {

  /** `git status` of the thread's working directory. Refused by name outside a repository. */
  'git.status': { params: { threadId: ThreadId }; result: GitStatus };
  /**
   * One file's two sides. `ref` is what the working tree is compared to, HEAD
   * by default. `oldPath` is the origin `git.status` gave the path, null for
   * none: given, the core reads that side without a status of its own, and
   * the answer's `status` is `renamed` or what the two sides show (`added`,
   * `deleted`, `modified`). Absent, the core asks git for the origin.
   */
  'git.diff': { params: { threadId: ThreadId; path: string; ref?: string; oldPath?: string | null }; result: GitDiff };

  /**
   * The linked worktrees of the project's repository, main checkout and the
   * project's own folder left out, each with what removing it would lose and
   * the thread standing in it. Owner only: it names paths.
   */
  'worktrees.list': { params: { projectId: ProjectId }; result: WorktreeEntry[] };
  /**
   * `git worktree remove`, then `git branch -d` on its branch (`-D` with
   * `force`), then `git worktree prune --expire 1.hour.ago`. Refused by name
   * for a path git does not list for this project, the main checkout, and a
   * worktree a thread that is not archived stands in; refused without `force`
   * when it is dirty or unmerged. A missing directory only loses its
   * registration. `branchDeleted` is false when git kept the branch (not
   * merged, checked out elsewhere) or there was none. Owner only.
   */
  'worktrees.remove': {
    params: { projectId: ProjectId; path: string; force?: boolean };
    result: { ok: true; branchDeleted: boolean };
  };
}
