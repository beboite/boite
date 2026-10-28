import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Project, ThreadSummary } from '@boite/contracts';
import type { Core } from './core.ts';
import { inside, keyOf } from './checkouts.ts';
import { refused } from './errors.ts';
import { occupiesCheckout } from './threads/occupancy.ts';

/** Resolve aliases, including a vanished folder through its nearest existing parent. */
export async function realKey(path: string): Promise<string> {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try { return keyOf(join(await realpath(head), ...tail)); }
    catch {
      const parent = dirname(head);
      if (parent === head) return keyOf(path);
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

interface Occupant { thread: ThreadSummary; draft: boolean }

/** Resolve folders asynchronously, then re-read every occupant in the final synchronous check. */
async function occupancy(core: Core, path: string): Promise<() => Occupant | null | 'moved'> {
  const key = await realKey(path);
  const threads = (): Occupant[] => [
    ...core.threads.list({ includeArchived: true }).map(thread => ({ thread, draft: false })),
    ...core.drafts.threads().map(thread => ({ thread, draft: true })),
  ];
  const keys = new Map<string, string>();
  await Promise.all([...new Set(threads().map(({ thread }) => thread.cwd))].map(async cwd => { keys.set(cwd, await realKey(cwd)); }));
  return () => {
    let holder: Occupant | null = null;
    for (const occupant of threads()) {
      const { thread, draft } = occupant;
      const at = keys.get(thread.cwd);
      if (at === undefined) return 'moved';
      if (holder === null && inside(key, at) && occupiesCheckout(core, draft ? { ...thread, deleted: true } : thread)) holder = occupant;
    }
    return holder;
  };
}

function refuseOccupied(project: Project, path: string, occupant: Occupant | null): void {
  if (occupant === null) return;
  const holder = occupant.thread;
  const why = occupant.draft ? 'is a draft whose agent still runs there: send it, or discard it and let it stop'
    : holder.archived ? 'is still running there: wait for it to finish' : 'works there: archive it first';
  throw refused(`thread "${holder.title}" (${holder.id}) ${why} (${path})`, {
    projectId: project.id, path, threadId: holder.id, threadTitle: holder.title,
    field: 'path', expected: 'a worktree no live thread uses',
  });
}

export async function assertCheckoutVacant(core: Core, project: Project, path: string): Promise<void> {
  for (;;) {
    const holder = (await occupancy(core, path))();
    if (holder === 'moved') continue;
    refuseOccupied(project, path, holder);
    return;
  }
}

/** No await separates the final occupancy check and reservation, held through the actual deletion. */
export async function withVacantCheckout<T>(core: Core, project: Project, path: string, remove: () => Promise<T>, aliases: readonly string[] = []): Promise<T> {
  const keys = await Promise.all([path, ...aliases].map(realKey));
  for (;;) {
    const holder = (await occupancy(core, path))();
    if (holder === 'moved') continue;
    refuseOccupied(project, path, holder);
    core.worktrees.reservations.assertFree(path, 'another checkout removal');
    const release = core.worktrees.reservations.reserve(path, keys);
    try { return await remove(); }
    finally { release(); }
  }
}
