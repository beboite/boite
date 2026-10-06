import type { ProjectId, ThreadId, ThreadSummary } from '@boite/contracts';
import { confirm } from './confirm.svelte';
import { contextMenu } from './context-menu.svelte';
import { projectName } from './format';
import type { MenuItem } from './menu';
import { fill, strings } from './strings';
import type { Store } from './store.svelte';
import { workingThread } from './thread-rows';

/** What a thread row carries while it is dragged: the machine it lives on, so a drop elsewhere is ignored. */
export interface ThreadDrag {
  machineId: string;
  threadId: ThreadId;
  projectId: ProjectId | null;
}

/** The card that follows the mouse: the row's look, its width, and where the mouse took it. */
export interface DragGhost {
  title: string;
  providerId: string;
  width: number;
  /** The grab point inside the row, so the card stays under the mouse where it was taken. */
  dx: number;
  dy: number;
}

/**
 * The row being dragged, and the project section it would drop on, keyed as
 * `dropKey` gives it: the section draws its outline from it. The ghost, the
 * mouse and the target's name draw the card that follows the mouse.
 */
export const threadDrag = $state<{
  current: ThreadDrag | null;
  over: string | null;
  target: string | null;
  ghost: DragGhost | null;
  x: number;
  y: number;
}>({ current: null, over: null, target: null, ghost: null, x: 0, y: 0 });

/** A project section's key while a row hovers it. */
export function dropKey(machineId: string, projectId: ProjectId): string {
  return `${machineId}:${projectId}`;
}

/** Whether a drop of the dragged row on this project would move it. */
export function takesDrop(drag: ThreadDrag | null, machineId: string, projectId: ProjectId): boolean {
  return drag !== null && drag.machineId === machineId && drag.projectId !== projectId;
}

/** How far the mouse goes, in pixels, before a press on a row becomes a drag rather than a click. */
const DRAG_THRESHOLD = 5;

/** A project section a row can land on: its machine, its id, and the name the card shows. */
interface DropTarget {
  machineId: string;
  projectId: ProjectId;
  name: string;
}

/** The project section or idle project row under a point, from its own data: each marks itself with `data-thread-drop`. */
function sectionAt(x: number, y: number): DropTarget | null {
  const section = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-thread-drop][data-project-id][data-machine-id]');
  const projectId = section?.dataset['projectId'], machineId = section?.dataset['machineId'];
  return projectId && machineId !== undefined ? { machineId, projectId: projectId as ProjectId, name: section?.dataset['projectName'] ?? '' } : null;
}

/** How close to the list's top or bottom, in pixels, the mouse scrolls it, and how far one frame goes at most. */
const SCROLL_EDGE = 40;
const SCROLL_STEP = 16;

/** The list the row scrolls in: a drag near its edge scrolls it, as a native drag would. */
function scrollerOf(element: Element | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/**
 * Drags a thread row with the mouse onto another project's section, from the
 * row's `pointerdown`. Pointer events rather than HTML drag and drop: the
 * desktop shell's native drop (folders dropped to add a project) takes every
 * drag over the window on Windows, so a page's own `dragover` and `drop` never
 * fire there. A press that does not travel stays a click; Escape cancels.
 * `look` is what the card that follows the mouse shows of the row.
 */
export function startThreadDrag(event: PointerEvent, store: Store, drag: ThreadDrag, look: { title: string; providerId: string }): void {
  if (event.button !== 0 || event.pointerType !== 'mouse' || threadDrag.current) return;
  const startX = event.clientX, startY = event.clientY, pointer = event.pointerId;
  const row = event.currentTarget instanceof Element ? event.currentTarget : null;
  let dragging = false;
  let frame = 0;
  let list: HTMLElement | null = null;
  const root = document.documentElement;
  const aim = (): void => {
    const at = sectionAt(threadDrag.x, threadDrag.y);
    const lands = at !== null && takesDrop(drag, at.machineId, at.projectId);
    threadDrag.over = lands ? dropKey(at.machineId, at.projectId) : null;
    threadDrag.target = lands ? at.name : null;
  };
  // Near the list's edge the list scrolls, faster the closer the mouse, and the target follows what comes under it.
  const scroll = (): void => {
    frame = 0;
    if (!dragging || !list) return;
    const box = list.getBoundingClientRect();
    if (box.height === 0) return;
    const y = threadDrag.y;
    const depth = y < box.top + SCROLL_EDGE ? y - box.top - SCROLL_EDGE : y > box.bottom - SCROLL_EDGE ? y - box.bottom + SCROLL_EDGE : 0;
    if (depth === 0) return;
    const before = list.scrollTop;
    list.scrollTop += Math.sign(depth) * Math.min(SCROLL_STEP, 2 + Math.abs(depth) / 3);
    if (list.scrollTop !== before) aim();
    frame = requestAnimationFrame(scroll);
  };
  const move = (e: PointerEvent): void => {
    if (!dragging) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
      dragging = true;
      const box = row?.getBoundingClientRect();
      threadDrag.ghost = { ...look, width: box?.width || 240, dx: box ? startX - box.left : 16, dy: box ? startY - box.top : 16 };
      threadDrag.current = drag;
      list = scrollerOf(row);
      // Held by the row, a drag still ends when the mouse is released outside the window.
      try { row?.setPointerCapture?.(pointer); } catch { /* A pointer already gone: the window's events still end the drag. */ }
      root.classList.add('thread-dragging');
      window.getSelection()?.removeAllRanges();
    }
    e.preventDefault();
    threadDrag.x = e.clientX;
    threadDrag.y = e.clientY;
    aim();
    if (!frame && typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(scroll);
  };
  const finish = (target: DropTarget | null): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', escape, true);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    root.classList.remove('thread-dragging');
    threadDrag.current = null;
    threadDrag.over = null;
    threadDrag.target = null;
    threadDrag.ghost = null;
    if (!dragging) return;
    // The click that ends a drag opens nothing; none comes when the mouse left the row.
    const swallow = (e: MouseEvent): void => { e.preventDefault(); e.stopPropagation(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    if (target && takesDrop(drag, target.machineId, target.projectId)) void moveThread(store, drag.threadId, target.projectId);
  };
  const up = (e: PointerEvent): void => finish(dragging ? sectionAt(e.clientX, e.clientY) : null);
  const cancel = (): void => finish(null);
  // Escape ends the drag only: elsewhere on the page it stops the turn.
  const escape = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !dragging) return;
    e.preventDefault();
    e.stopPropagation();
    finish(null);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', escape, true);
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
  return store.moveBlocked(threadId);
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
  const running = workingThread(thread.status);
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
