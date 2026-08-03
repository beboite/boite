/**
 * What a project is, for the features that only need to recognise one.
 *
 * The second file of `lib/domain`: rules the features share, with no runes, no
 * Svelte imports and no store behind them.
 *
 * This one exists because `isScratch` lived inside the project feature, and
 * five other features need it — git to know there is no repository worth
 * drawing, explorer and todo and the shortcut menu to know what to call it,
 * thread to know a launch has nowhere of its own yet. Each of those imports
 * made a cycle with `project`, which imports back from most of them. Nothing
 * about the rule belongs to the feature; it is one comparison.
 */

/**
 * The project for threads that are not about a project yet.
 *
 * Boite used to have nothing to open a terminal in but a folder someone had
 * already decided was a project, which is the wrong way round for how work
 * actually starts: an idea gets talked through first, and only then does it
 * earn a repository. Scratch is where that conversation happens — the user's
 * home folder, no worktree, no git panel worth looking at — until a project is
 * created and the thread moves in.
 *
 * Fixed rather than generated: the row is recreated on a machine that has never
 * had one, and a thread that moved out of it must not find a second one waiting
 * under a different id after a reinstall.
 */
export const SCRATCH_PROJECT_ID = "boite-scratch";

export function isScratch(project: { id: string } | null | undefined): boolean {
  return project?.id === SCRATCH_PROJECT_ID;
}
