import type { ThreadSummary } from '@boite/contracts';
import { projectKey, type ProjectEntry } from './project-view.svelte';
import { groupWorkingThread, workingThread } from './recent.svelte';
import { compareThreads } from './thread-order';

export type ProjectThreadKind = 'working' | 'done';

/** Expansion follows a project across desktop and phone, without mixing machines. */
export class ProjectThreadView {
  working = $state<string[]>([]);
  done = $state<string[]>([]);
  otherOpen = $state(false);

  isOpen(entry: ProjectEntry, kind: ProjectThreadKind): boolean {
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

/** An ungrouped conversation or draft keeps its project in the main list. */
export function activeProject(entry: ProjectEntry): boolean {
  const store = entry.machine.store;
  return store.threadsOf(entry.project.id).some(thread => !groupWorkingThread(store, thread))
    || store.draftEntries.some(draft => draft.projectId === entry.project.id);
}

/** Protected working rows stay visible while folded and appear only once when unfolded. */
export function projectThreadLists(entry: ProjectEntry, threads: ThreadSummary[], workingOpen: boolean): {
  working: ThreadSummary[]; attention: ThreadSummary[];
} {
  const sorted = threads.slice().sort(compareThreads);
  return {
    working: sorted.filter(workingThread),
    attention: sorted.filter(thread => workingOpen ? !workingThread(thread) : !groupWorkingThread(entry.machine.store, thread))
  };
}
