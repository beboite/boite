import { gitCommitState, gitPullRequest } from "$lib/features/git/api";
import type { PrLookup } from "$lib/features/git/api";
import type { CommitStateAnswer } from "$lib/backend/types";

/**
 * What a claimed item's commit turned out to be, once git and gh had answered.
 *
 * `CommitStateAnswer` rather than `CommitState`: whether the repository was
 * reached is part of what this turned out to be, and typing the field to the
 * narrower shape dropped the flag one level below the strip that draws it.
 */
export interface ClaimGit {
  commit: CommitStateAnswer;
  pr: PrLookup;
}

/**
 * Module level rather than per component, which is the whole point of the file.
 * The todo panel is destroyed when the side panel switches to Files and rebuilt
 * on the way back, so a cache living in the component started empty every time
 * and the strip went blank, then filled in — one `rev-parse` and one `gh` call
 * per visit. The git panel feels instant for exactly this reason: its state
 * outlives its component.
 *
 * Keyed by repository and sha together: the answer is about that commit in that
 * clone, and a re-claim with a different sha has to be looked up again.
 */
const cache = new Map<string, Promise<ClaimGit>>();

export function claimGitState(root: string, sha: string): Promise<ClaimGit> {
  const key = `${root}:${sha}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const pending = (async (): Promise<ClaimGit> => {
    const commit = await gitCommitState(root, sha).catch(() => null);
    if (!commit || !commit.known) {
      return {
        // A rejected lookup carries no answer, only a shape the strip needs to
        // render at all. It used to be filled in with `known: false` alone,
        // which is git stating it has never seen the sha, so a clone nobody
        // managed to ask was drawn as a clone that denied the commit.
        commit: commit ?? {
          known: false,
          pushed: false,
          short: sha.slice(0, 7),
          subject: null,
          branch: null,
          unreachable: true,
        },
        pr: { kind: "unavailable" },
      };
    }
    // Only ask the forge about work that reached it. An unpushed commit has no
    // pull request by definition, and asking would spend a network call to be
    // told so.
    const pr: PrLookup =
      commit.pushed && commit.branch
        ? await gitPullRequest(root, commit.branch).catch(
            (err): PrLookup => ({ kind: "failed", auth: false, detail: String(err) }),
          )
        : { kind: "unavailable" };
    return { commit, pr };
  })();

  cache.set(key, pending);
  // A failed lookup should not be the answer forever — the next visit asks
  // again, which is how a `gh auth login` in between gets noticed.
  void pending.then((r) => {
    if (r.pr.kind === "failed") cache.delete(key);
  });
  return pending;
}
