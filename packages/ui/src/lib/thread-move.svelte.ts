import type { ProjectId, ThreadId, ThreadStatus, ThreadSummary } from '@boite/contracts';
import { confirm } from './confirm.svelte';
import { contextMenu } from './context-menu.svelte';
import { projectName } from './format';
import type { MenuItem } from './menu';
import { fill, strings } from './strings';
import type { Store } from './store.svelte';

const LIVE: ThreadStatus[] = ['running', 'queued', 'waiting'];

/** What a thread row carries while it is dragged: the machine it lives on, so a drop elsewhere is ignored. */
export interface ThreadDrag {
  machineId: string;
  threadId: ThreadId;
  projectId: ProjectId | null;
}

/** The drag's data type, so a file or text dragged over the sidebar is never taken for a thread. */
export const THREAD_DRAG_TYPE = 'application/x-boite-thread';

/**
 * The row being dragged. `dragover` cannot read a drag's data, only its types,
 * so the target project reads this to decide whether it takes the drop.
 */
export const threadDrag = $state<{ current: ThreadDrag | null }>({ current: null });

/** Whether a drop of the dragged row on this project would move it. */
export function takesDrop(drag: ThreadDrag | null, machineId: string, projectId: ProjectId): boolean {
  return drag !== null && drag.machineId === machineId && drag.projectId !== projectId;
}

function find(store: Store, threadId: ThreadId): ThreadSummary | null {
  return store.threads.find((t) => t.id === threadId) ?? (store.openThread?.id === threadId ? store.openThread : null);
}

/**
 * Whether a turn runs in the thread or one of its sub-threads. The core
 * refuses the move then: a stopped turn can leave half-done edits in the old
 * folder, so the user stops it first and sees what it left.
 */
export function moveBlocked(store: Store, threadId: ThreadId): boolean {
  const thread = find(store, threadId);
  if (thread && LIVE.includes(thread.status)) return true;
  return store.threads.some((t) => t.parentThreadId === threadId && !t.archived && LIVE.includes(t.status));
}

/** The picker's rows: every other project of the thread's machine, an archived one marked, or one row saying there is none. */
export function moveTargets(store: Store, thread: Pick<ThreadSummary, 'projectId'>): MenuItem[] {
  const others = store.projects.filter((p) => p.id !== thread.projectId);
  if (others.length === 0) return [{ id: 'none', label: strings.threadMove.noOtherProject, disabled: true }];
  return others.map((p) => ({
    id: p.id,
    label: p.archived === true ? fill(strings.threadMove.archivedProject, { project: projectName(p) }) : projectName(p),
    hint: p.path,
  }));
}

/**
 * The one way the UI moves a thread (row menu, title menu, drag). Background
 * work asks first: stop it, or keep it running in the old folder until the
 * agent's next turn starts in the new one. The target project unfolds so the
 * row stays in sight.
 */
export async function moveThread(store: Store, threadId: ThreadId, projectId: ProjectId): Promise<boolean> {
  const thread = find(store, threadId);
  if (!thread || thread.projectId === projectId) return false;
  if (moveBlocked(store, threadId)) {
    store.error = strings.threadMove.stopFirst;
    return false;
  }
  const target = store.projects.find((p) => p.id === projectId);
  const kinds = [thread, ...store.threads.filter((t) => t.parentThreadId === threadId)].flatMap((t) => t.backgroundWork?.kinds ?? []);
  let stopBackground: boolean | undefined;
  if (kinds.length > 0) {
    const monitors = kinds.every((kind) => kind === 'monitor');
    const choice = await confirm.choose({
      title: monitors ? strings.threadMove.monitorsTitle : strings.threadMove.backgroundTitle,
      body: fill(strings.threadMove.backgroundBody, { folder: thread.cwd, project: target ? projectName(target) : projectId }),
      confirmLabel: monitors ? strings.threadMove.stopMonitors : strings.threadMove.stopWork,
      altLabel: strings.threadMove.keep,
      cancelLabel: strings.common.cancel,
      danger: true,
    });
    if (choice === 'cancel') return false;
    stopBackground = choice === 'confirm';
  }
  const moved = await store.move(threadId, projectId, stopBackground);
  if (moved === null) return false;
  if (store.isCollapsed(projectId)) store.toggleProject(projectId);
  return true;
}

/**
 * The project picker, opened from a pick of a thread menu. `anchor` places it
 * under a phone's title sheet trigger; without one it opens where the menu stood.
 */
export function openMovePicker(store: Store, thread: Pick<ThreadSummary, 'id' | 'projectId'>, anchor?: HTMLElement | null): void {
  const items = moveTargets(store, thread);
  const pick = (id: string): void => {
    if (id !== 'none') void moveThread(store, thread.id, id);
  };
  const rect = anchor?.getBoundingClientRect();
  if (anchor && rect && rect.width > 0) contextMenu.show({ x: rect.left, y: rect.bottom }, items, pick, anchor);
  else contextMenu.follow(items, pick);
}

/** The "Move to project" row of a thread menu, out while a turn runs. */
export function moveItem(store: Store, threadId: ThreadId): MenuItem {
  const blocked = moveBlocked(store, threadId);
  return { id: 'move', label: strings.threadMove.moveTo, disabled: blocked, ...(blocked ? { title: strings.threadMove.stopFirst } : {}) };
}
