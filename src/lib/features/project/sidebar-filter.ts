/**
 * Narrowing the sidebar without leaving it.
 *
 * The palette already finds a thread, and it finds it by taking the screen,
 * showing a ranked list of everything in the workspace and jumping somewhere.
 * That is the right answer to "take me to X" and the wrong one to "which of
 * these forty is the one about the migration": the second question is asked
 * while looking at the list, and the answer has to keep the list where it is.
 *
 * So this filters in place and keeps the shape: same projects, same order, same
 * cards, fewer rows.
 *
 * Substring rather than the palette's fuzzy match, deliberately. Fuzzy scoring
 * exists to rank a jump target out of everything there is; here every row is
 * already on screen and the user is removing rows, so a match on scattered
 * letters leaves things in the list with no visible reason for being there.
 */

export interface FilterableThread {
  id: string;
  label: string;
  title: string | null;
}

export interface FilterableProject {
  id: string;
}

export function normaliseTerm(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Both names, because a row shows one and the palette searches the other. */
export function threadMatches(thread: FilterableThread, term: string): boolean {
  if (!term) return true;
  const title = thread.title?.toLowerCase() ?? "";
  return title.includes(term) || thread.label.toLowerCase().includes(term);
}

export function projectMatches(name: string, term: string): boolean {
  if (!term) return true;
  return name.toLowerCase().includes(term);
}

/**
 * What each project shows under a term.
 *
 * A project whose own name matches keeps all of its threads: typing a project
 * name is asking for the project, and hiding its threads answers a question
 * nobody asked. A project that matches on neither its name nor any thread is
 * dropped, since an empty card is a row of noise between the ones that matched.
 */
export function filterSidebar<
  P extends FilterableProject,
  T extends FilterableThread,
>(
  projects: readonly P[],
  threadsOf: (projectId: string) => T[],
  // The name on the row, which is not always `project.name`: a scratch project
  // is drawn under a name the store does not hold.
  nameOf: (project: P) => string,
  rawTerm: string,
): { projects: P[]; threads: Map<string, T[]> } {
  const term = normaliseTerm(rawTerm);
  const threads = new Map<string, T[]>();
  if (!term) {
    for (const project of projects) threads.set(project.id, threadsOf(project.id));
    return { projects: [...projects], threads };
  }
  const kept: P[] = [];
  for (const project of projects) {
    const all = threadsOf(project.id);
    if (projectMatches(nameOf(project), term)) {
      kept.push(project);
      threads.set(project.id, all);
      continue;
    }
    const hits = all.filter((thread) => threadMatches(thread, term));
    if (hits.length === 0) continue;
    kept.push(project);
    threads.set(project.id, hits);
  }
  return { projects: kept, threads };
}
