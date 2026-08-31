import { samePath, pathKey } from "$lib/features/project/path";
import { isScratch } from "$lib/domain/project";
import { logger } from "$lib/shared/services/logger.svelte";
import { threadCwd } from "./cwd";
import type { Project, Thread } from "$lib/types";

/**
 * The directory an agent declared that might be a worktree of this project,
 * or null when there is nothing to ask about.
 *
 * Same path as the thread already runs in, or as the project itself, is not a
 * discovery: that is where we put it. Only a different directory is worth
 * asking the backend about.
 */
export function cwdToRecognize(
  declared: string | null | undefined,
  currentCwd: string | null | undefined,
  projectCwd: string | null | undefined,
): string | null {
  const cwd = declared?.trim();
  if (!cwd) return null;
  if (currentCwd && samePath(cwd, currentCwd)) return null;
  if (projectCwd && samePath(cwd, projectCwd)) return null;
  return cwd;
}

const asked = new Set<string>();
const inflight = new Set<string>();

export interface NoticeDeclaredCwd {
  thread: Thread;
  project: Project | null | undefined;
  declared: string | null | undefined;
  recognize: (repo: string, path: string) => Promise<string | null>;
  persist: (path: string) => Promise<void>;
}

/**
 * When an agent has put itself in a worktree we did not open, remember that
 * path on the thread so resume, the git panel, close and the next spawn all
 * use it.
 *
 * Fire-and-forget: the status tick must not wait on an IPC round trip, and a
 * miss this second is asked again on the next one until an answer lands.
 */
export function noticeDeclaredCwd(opts: NoticeDeclaredCwd): void {
  const project = opts.project;
  if (!project || isScratch(project)) return;
  const current = threadCwd(opts.thread, project);
  const candidate = cwdToRecognize(opts.declared, current, project.cwd);
  if (!candidate) return;
  const key = `${opts.thread.id}:${pathKey(candidate)}`;
  if (asked.has(key) || inflight.has(key)) return;
  inflight.add(key);
  const repo = project.gitRoot ?? project.cwd;
  void opts
    .recognize(repo, candidate)
    .then(async (found) => {
      if (!found) {
        asked.add(key);
        return;
      }
      if (opts.thread.worktreePath && samePath(opts.thread.worktreePath, found)) {
        asked.add(key);
        return;
      }
      await opts.persist(found);
      asked.add(key);
    })
    .catch((err) => {
      logger.warn("worktree", `recognize failed for ${opts.thread.id}`, String(err));
    })
    .finally(() => {
      inflight.delete(key);
    });
}

/** Tests only: the cache lives for the window, and each spec starts empty. */
export function resetNoticeCache() {
  asked.clear();
  inflight.clear();
}
