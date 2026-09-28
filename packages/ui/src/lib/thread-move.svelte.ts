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
 * Whether a sub-thread of this thread works. The core refuses the move then:
 * the parent's turn end is no moment to move a thread whose child still runs.
 * The thread's own turn is no reason: its move waits for the turn to end.
 */
export function moveBlocked(store: Store, threadId: ThreadId): boolean {
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
 * The one way the UI moves a thread (row menu, title menu, drag). A running
 * turn asks first and the move waits for the turn to end; a second move
 * replaces the waiting one. Background work asks too: stop it with the move,
 * or keep it running in the old folder until the agent's next turn starts in
 * the new one. The target project unfolds so the row stays in sight.
 */
export async function moveThread(store: Store, threadId: ThreadId, projectId: ProjectId): Promise<boolean> {
  const thread = find(store, threadId);
  if (!thread || thread.projectId === projectId) return false;
  if (moveBlocked(store, threadId)) {
    store.error = strings.threadMove.stopFirst;
    return false;
  }
  const target = store.projects.find((p) => p.id === projectId);
  const names = { folder: thread.cwd, project: target ? projectName(target) : projectId };
  const running = LIVE.includes(thread.status);
  const kinds = [thread, ...store.threads.filter((t) => t.parentThreadId === threadId)].flatMap((t) => t.backgroundWork?.kinds ?? []);
  let stopBackground: boolean | undefined;
  if (kinds.length > 0) {
    const monitors = kinds.every((kind) => kind === 'monitor');
    const choice = await confirm.choose({
      title: running ? strings.threadMove.runningTitle : monitors ? strings.threadMove.monitorsTitle : strings.threadMove.backgroundTitle,
      body: fill(running ? strings.threadMove.runningBackgroundBody : strings.threadMove.backgroundBody, names),
      confirmLabel: monitors ? strings.threadMove.stopMonitors : strings.threadMove.stopWork,
      altLabel: strings.threadMove.keep,
      cancelLabel: strings.common.cancel,
      danger: true,
    });
    if (choice === 'cancel') return false;
    stopBackground = choice === 'confirm';
  } else if (running) {
    const go = await confirm.ask({
      title: strings.threadMove.runningTitle,
      body: fill(strings.threadMove.runningBody, names),
      confirmLabel: strings.threadMove.runningConfirm,
      cancelLabel: strings.common.cancel,
    });
    if (!go) return false;
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

/**
 * The move rows of a thread menu: "Move to project", out while a sub-thread
 * works, and "Cancel move" while a move waits for the turn to end. The menu
 * picks them as `move` and `move-cancel`; `pickMoveItem` answers both.
 */
export function moveItems(store: Store, thread: Pick<ThreadSummary, 'id' | 'pendingMove'>): MenuItem[] {
  const blocked = moveBlocked(store, thread.id);
  const move: MenuItem = { id: 'move', label: strings.threadMove.moveTo, disabled: blocked, ...(blocked ? { title: strings.threadMove.stopFirst } : {}) };
  return thread.pendingMove ? [move, { id: 'move-cancel', label: strings.threadMove.cancelMove }] : [move];
}

/** Answers a pick of `moveItems`' rows; false for any other row. */
export function pickMoveItem(store: Store, thread: Pick<ThreadSummary, 'id' | 'projectId'>, action: string, anchor?: HTMLElement | null): boolean {
  if (action === 'move') openMovePicker(store, thread, anchor);
  else if (action === 'move-cancel') void store.cancelMove(thread.id);
  else return false;
  return true;
}

/** The "Moves to <project> after this turn" line, or null. */
export function pendingLine(thread: Pick<ThreadSummary, 'pendingMove'>): string | null {
  return thread.pendingMove ? fill(strings.threadMove.pending, { project: thread.pendingMove.project }) : null;
}
