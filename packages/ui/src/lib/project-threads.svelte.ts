import type { Project, ThreadSummary } from '@boite/contracts';
import { projectKey, type ProjectEntry } from './project-view.svelte';
import { groupWorkingThread, recentPreferences, workingThread } from './recent.svelte';
import { compareThreads } from './thread-order';

export type ProjectThreadKind = 'working' | 'done' | 'archived';
/** The two kinds of row in the fold under the project list: projects with no open conversation, and projects put out of the list. */
export type ProjectShelfKind = 'idle' | 'archived';
/** Where the Projects view lists a project: at work at the top, open, set aside, or in the idle fold. */
export type ProjectSection = 'working' | 'open' | 'later' | 'idle';
/** Archived conversations split in two: done ones (marked done, PR merged) leave after a delay, the others wait to be picked up again. */
export type ArchiveKind = 'done' | 'archived';

/** How many archived threads of a project are done and how many were put aside by hand. */
export function archiveCount(project: Project, kind: ArchiveKind): number {
  const done = project.doneThreads ?? 0;
  return kind === 'done' ? done : Math.max(0, (project.archivedThreads ?? 0) - done);
}

/** Whether an archived thread belongs to the done list or the archived one. */
export function archiveKindOf(thread: ThreadSummary): ArchiveKind {
  return thread.doneAt != null ? 'done' : 'archived';
}

/** Expansion follows a project across desktop and phone, without mixing machines. */
export class ProjectThreadView {
  working = $state<string[]>([]);
  done = $state<string[]>([]);
  archived = $state<string[]>([]);
  /** The folds of idle and of archived projects start closed and stay as left, across desktop and phone, for this session. */
  shelfOpen = $state(false);
  archivedShelfOpen = $state(false);
  /** The sections of projects at work and set aside start open, as they hold work. */
  workingOpen = $state(true);
  laterOpen = $state(true);

  isOpen(entry: ProjectEntry, kind: ProjectThreadKind): boolean {
    if (kind === 'working' && !recentPreferences.groupWorking) return false;
    return this[kind].includes(projectKey(entry));
  }

  toggle(entry: ProjectEntry, kind: ProjectThreadKind, collapsed = false): void {
    const key = projectKey(entry);
    const open = this[kind].includes(key);
    if (collapsed) entry.machine.store.toggleProject(entry.project.id);
    if (collapsed && open) return;
    this[kind] = open ? this[kind].filter(value => value !== key) : [...this[kind], key];
  }

  /** Unfolding a project whose only rows are folded working ones opens them too, so the fold never comes up empty. */
  toggleProject(entry: ProjectEntry, lists: ThreadLists, drafts: number): void {
    const store = entry.machine.store;
    const unfolding = store.isCollapsed(entry.project.id);
    store.toggleProject(entry.project.id);
    if (unfolding && lists.attention.length === 0 && drafts === 0 && lists.working.length > 0 && recentPreferences.groupWorking && !this.isOpen(entry, 'working')) {
      this.working = [...this.working, projectKey(entry)];
    }
  }
}

export const projectThreadView = new ProjectThreadView();

/** A conversation or draft keeps its project visible, including folded working rows. The open draft counts before it has text, though it lists no row yet. */
export function activeProject(entry: ProjectEntry): boolean {
  const store = entry.machine.store;
  return store.threadsOf(entry.project.id).length > 0
    || store.draft?.projectId === entry.project.id
    || store.draftEntries.some(draft => draft.projectId === entry.project.id);
}

/**
 * Working: every conversation it holds is at work and nothing there holds the user's input (a pin, unsent text in a
 * conversation or in a new draft), so a folded section never hides what waits on the user.
 * Open: any other conversation or draft. Later: nothing open, but conversations archived by hand to pick up again.
 * Idle: none of these, at most a done history.
 */
export function projectSection(entry: ProjectEntry): ProjectSection {
  const store = entry.machine.store;
  const threads = store.threadsOf(entry.project.id);
  if (threads.length > 0 && threads.every(thread => groupWorkingThread(store, thread))
    && !store.draftEntries.some(draft => draft.projectId === entry.project.id)) return 'working';
  if (activeProject(entry)) return 'open';
  return archiveCount(entry.project, 'archived') > 0 ? 'later' : 'idle';
}

/**
 * The listed projects split by section, each in the order it came in. Without working grouping, projects at work stay
 * open cards; without idle grouping, set-aside and idle projects do too.
 */
export function projectSections(entries: readonly ProjectEntry[], groupIdle: boolean, groupWorking: boolean): Record<ProjectSection, ProjectEntry[]> {
  const sections: Record<ProjectSection, ProjectEntry[]> = { working: [], open: [], later: [], idle: [] };
  for (const entry of entries) {
    const section = projectSection(entry);
    const grouped = section === 'working' ? groupWorking : groupIdle;
    sections[grouped ? section : 'open'].push(entry);
  }
  return sections;
}

/** Protected working rows stay visible while folded and appear only once when unfolded. */
export function projectThreadLists(entry: ProjectEntry, threads: ThreadSummary[], workingOpen: boolean): {
  working: ThreadSummary[]; attention: ThreadSummary[];
} {
  const sorted = threads.slice().sort(compareThreads);
  return {
    working: sorted.filter(thread => workingThread(entry.machine.store, thread)),
    attention: recentPreferences.groupWorking
      ? sorted.filter(thread => workingOpen ? !workingThread(entry.machine.store, thread) : !groupWorkingThread(entry.machine.store, thread))
      : sorted
  };
}

type ThreadLists = ReturnType<typeof projectThreadLists>;

/** One project's drawn lists, sorted once for its rows and for Alt+digit; it reads only its own project's threads. */
export class ProjectLists {
  readonly entry: ProjectEntry;
  readonly lists: ThreadLists = $derived.by(() => projectThreadLists(this.entry, this.entry.machine.store.threadsOf(this.entry.project.id), projectThreadView.isOpen(this.entry, 'working')));
  constructor(entry: ProjectEntry) { this.entry = entry; }
}

/**
 * Maps each listed project to its lists. A project whose entry is the same object
 * keeps its lists, so a change in one project's threads sorts that project alone.
 */
export function projectListMap(): (entries: readonly ProjectEntry[]) => Map<string, ProjectLists> {
  let previous = new Map<string, ProjectLists>();
  return entries => {
    const next = new Map<string, ProjectLists>();
    for (const entry of entries) {
      const key = projectKey(entry);
      const known = previous.get(key);
      next.set(key, known?.entry === entry ? known : new ProjectLists(entry));
    }
    previous = next;
    return next;
  };
}
