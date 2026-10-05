import type { Project, ThreadSummary } from '@boite/contracts';
import { projectKey, type ProjectEntry } from './project-view.svelte';
import { groupWorkingThread, recentPreferences, workingThread } from './recent.svelte';
import { compareThreads } from './thread-order';

export type ProjectThreadKind = 'working' | 'done' | 'archived';
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
  otherOpen = $state(false);

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
}

export const projectThreadView = new ProjectThreadView();

/** A conversation or draft keeps its project visible, including folded working rows. The open draft counts before it has text, though it lists no row yet. */
export function activeProject(entry: ProjectEntry): boolean {
  const store = entry.machine.store;
  return store.threadsOf(entry.project.id).length > 0
    || store.draft?.projectId === entry.project.id
    || store.draftEntries.some(draft => draft.projectId === entry.project.id);
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
