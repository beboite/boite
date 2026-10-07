import type { ProjectId, StewardGrant, ThreadSummary } from '@boite/contracts';
import type { Store } from './store.svelte';

/*
 * Who looks after what, for the views that show it: a steward is an ordinary
 * thread the owner granted projects to (docs/stewards.md). The thread list
 * marks the projects it covers and lists it among the agents; a thread it
 * covers names it in its header.
 */

/** A grant whose steward thread is still there and not archived: an archived steward's grant is suspended. */
function active(store: Pick<Store, 'threads'>, grant: StewardGrant): ThreadSummary | null {
  const thread = store.threads.find(t => t.id === grant.threadId);
  return thread && !thread.archived ? thread : null;
}

/** The stewards that look after a project, with their threads. The drafts project is never covered. */
export function stewardsOf(store: Pick<Store, 'threads' | 'projects' | 'stewards'>, projectId: ProjectId | null): { grant: StewardGrant; thread: ThreadSummary }[] {
  if (projectId === null || store.projects.find(p => p.id === projectId)?.kind === 'drafts') return [];
  return (store.stewards ?? []).flatMap(grant => {
    if (!grant.allProjects && !grant.projectIds.includes(projectId)) return [];
    const thread = active(store, grant);
    return thread ? [{ grant, thread }] : [];
  });
}

/** Every steward with its thread, for the list of agents above the projects. */
export function stewardsWithThreads(store: Pick<Store, 'threads' | 'stewards'>): { grant: StewardGrant; thread: ThreadSummary }[] {
  return (store.stewards ?? []).flatMap(grant => { const thread = active(store, grant); return thread ? [{ grant, thread }] : []; });
}

/** The steward looking after a thread, never the thread itself: a steward does not act on its own thread. */
export function stewardOfThread(store: Pick<Store, 'threads' | 'projects' | 'stewards'>, thread: Pick<ThreadSummary, 'id' | 'projectId'>): { grant: StewardGrant; thread: ThreadSummary } | null {
  return stewardsOf(store, thread.projectId).find(entry => entry.thread.id !== thread.id) ?? null;
}
