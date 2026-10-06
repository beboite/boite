import type { Project } from '@boite/contracts';
import { startPointerDrag, type DragGrip } from './pointer-drag';
import { projectView } from './project-view.svelte';
import type { Store } from './store.svelte';

/** The card a dragged project header becomes: its tile and name. */
export interface ProjectGhost extends DragGrip {
  name: string;
  project: Project;
  store: Store;
}

/**
 * The project being dragged and where it would land, each keyed as
 * `projectKey` gives it: `over` is the section the insertion line sits by,
 * before it or `after` it, and stays null where a drop would change nothing.
 */
export const projectDrag = $state<{
  current: string | null;
  over: string | null;
  after: boolean;
  ghost: ProjectGhost | null;
  x: number;
  y: number;
}>({ current: null, over: null, after: false, ghost: null, x: 0, y: 0 });

/** How long a finger holds a project header still before it lifts: shorter than the phone's own long press. */
export const PROJECT_HOLD = 350;

/** Whether putting `source` before or after `target` changes `order`. */
export function reorders(order: string[], source: string, target: string, after: boolean): boolean {
  const from = order.indexOf(source);
  const rest = order.filter((key) => key !== source);
  const at = rest.indexOf(target);
  return source !== target && from >= 0 && at >= 0 && at + Number(after) !== from;
}

/** The project section under a point: its key, and its upper or lower half. */
function sectionAt(x: number, y: number): { key: string; after: boolean } | null {
  const section = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-testid="project"][data-project-key]');
  const key = section?.dataset['projectKey'];
  if (!section || !key) return null;
  const box = section.getBoundingClientRect();
  return { key, after: y > box.top + box.height / 2 };
}

export interface ProjectDragOptions {
  key: string;
  look: Omit<ProjectGhost, keyof DragGrip>;
  /** The project keys in the order on screen. */
  order: () => string[];
  /** Puts the dragged project before or after `target`. */
  drop: (target: string, after: boolean) => void;
}

/**
 * Drags a project header to a new place in the list, from the header's
 * `pointerdown`, in the manual order only: the recent order places projects
 * itself. A mouse drags once it travels, a finger once it holds still; the
 * insertion line shows where the project lands, and Escape cancels.
 */
export function startProjectDrag(event: PointerEvent, options: ProjectDragOptions): void {
  if (projectView.order !== 'manual') return;
  const pressed = event.currentTarget instanceof Element ? event.currentTarget : null;
  const list = pressed?.closest('[data-project-list]') ?? null;
  startPointerDrag(event, {
    rootClass: 'project-dragging',
    hold: PROJECT_HOLD,
    lifted: pressed?.closest('[data-testid="project"]') ?? pressed,
    begin: (grip) => {
      projectDrag.ghost = { ...options.look, ...grip };
      projectDrag.current = options.key;
    },
    aim: (x, y) => {
      projectDrag.x = x;
      projectDrag.y = y;
      const at = sectionAt(x, y);
      if (at) {
        const moves = reorders(options.order(), options.key, at.key, at.after);
        projectDrag.over = moves ? at.key : null;
        projectDrag.after = at.after;
        return;
      }
      // Between two sections the line stays where it was; out of the list it goes.
      const box = list?.getBoundingClientRect();
      if (box && box.width > 0 && (x < box.left || x > box.right || y < box.top || y > box.bottom)) projectDrag.over = null;
    },
    end: (drop) => {
      const target = drop ? projectDrag.over : null, after = projectDrag.after;
      projectDrag.current = null;
      projectDrag.over = null;
      projectDrag.ghost = null;
      if (target) options.drop(target, after);
    },
  });
}
