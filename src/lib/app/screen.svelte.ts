import { invoke } from "$lib/backend/tauri/ipc";
import { hasTauri } from "$lib/backend/env";
import { app } from "$lib/app/store.svelte";
import { approvals } from "$lib/features/approvals/store.svelte";
import { paneLabel } from "$lib/features/panes/label";
import { paneStore } from "$lib/features/panes/store.svelte";
import { shownIn } from "$lib/features/panes/visible";
import { palette } from "$lib/features/palette/store.svelte";
import { browserPanes, type PageState } from "$lib/features/browser/state.svelte";

/**
 * The window describing what is on it, so nobody has to be asked.
 *
 * Everything else about a broken Boite is answerable without a human: the rows
 * say what exists, `livePtys` says what is running, the transcripts say what was
 * printed, the timeline says in what order. "Which panes are open, how big are
 * they, and what is covering them" was answerable only by looking at the screen,
 * which is why every session debugging this app began by asking.
 *
 * It goes into `workspace_snapshot` rather than behind a call of its own: an
 * agent working out why something looks wrong should not have to know this
 * exists. See `boite_core::screen` for the shape and for why it is words rather
 * than a screenshot.
 */

export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScreenPane {
  id: string;
  kind: string;
  title: string;
  threadId: string | null;
  /** The page in a browser pane, and the whole of what the frame gives back. */
  url: string | null;
  page: PageState | null;
  drivenBy: string | null;
  rect: ScreenRect;
  focused: boolean;
  /**
   * Whether the user can see it, which the rectangle does not answer.
   *
   * Every group of panes is mounted at once and the page hides all but one, so
   * a pane in a group nobody is looking at is laid out at the same coordinates
   * as the pane covering it. Without this the description called both of them
   * visible, and the screenshot took the top one's pixels for the other one's.
   */
  visible: boolean;
}

export interface Screen {
  at: number;
  projectId: string;
  window: { width: number; height: number; focused: boolean };
  panes: ScreenPane[];
  overlays: string[];
}

/**
 * How often the window says so again even when nothing moved.
 *
 * This is what makes `at` a heartbeat rather than a timestamp: a description
 * that stopped being refreshed is the diagnosis, and it is one nothing else in
 * the app can report. Long enough that an idle workspace is not writing every
 * few seconds for nobody.
 */
const HEARTBEAT_MS = 30_000;
/** How often it looks, which is not how often it sends. */
const LOOK_EVERY_MS = 5_000;

/**
 * What the panes actually are, read off the DOM rather than off the layout tree.
 *
 * The tree holds ratios and the elements hold pixels, and the interesting bugs
 * live in the difference: a pane with a ratio of 0.3 and a width of four pixels
 * is on the layout and not on the screen. Reading the elements also means what
 * is described is what is rendered, with no second idea of which group is
 * showing.
 */
function panesOnScreen(): ScreenPane[] {
  const leaves = Array.from(document.querySelectorAll<HTMLElement>("[data-pane-leaf]"));
  const panes = leaves.map((el) => {
    const id = el.dataset.paneLeaf ?? "";
    const content = paneStore.contentOf(id);
    const box = el.getBoundingClientRect();
    const browser = content?.kind === "browser" ? content : null;
    return {
      id,
      // A leaf the store no longer knows is worth reporting as it is: it means
      // the DOM and the tree disagree, which is a bug this is here to surface.
      kind: content?.kind ?? "unknown",
      title: content ? paneLabel(content) : "",
      threadId: content?.kind === "thread" ? content.threadId : null,
      // The address, how the frame's `load` went, and whose pane it is. This is
      // every browser tool's only source: nothing else on this side can see a
      // cross-origin frame, so what is not here is not knowable.
      url: browser?.url ?? null,
      page: browser ? browserPanes.pageOf(id) : null,
      drivenBy: browser?.drivenBy ?? null,
      rect: { x: box.x, y: box.y, w: box.width, h: box.height },
      focused: paneStore.groupOf(id)?.focusedPaneId === id,
      visible: shownIn(el),
    };
  });
  // Reading order, which is the order somebody describing their screen would
  // use. Rows first, because a horizontal split is the common one.
  return panes.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

/**
 * What is over the layout.
 *
 * Named rather than counted: "a dialog is open" answers most reports of a window
 * that has stopped responding to anything, and a number does not. The modal is
 * read off the DOM by the same selector the keyboard controller uses to decide
 * whether a shortcut belongs to it, so the two cannot disagree about what is
 * open.
 */
function overlaysOnScreen(): string[] {
  const out: string[] = [];
  const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
  for (const dialog of dialogs) {
    const label = dialog.getAttribute("aria-label") ?? dialog.getAttribute("aria-labelledby") ?? "";
    out.push(label ? `dialog: ${label}` : "dialog");
  }
  if (palette.open) out.push("command palette");
  if (approvals.pending.length > 0) {
    out.push(`approval card, ${approvals.pending.length} waiting`);
  }
  return out;
}

/** What the window would say if asked right now. */
export function describeScreen(): Screen | null {
  if (typeof document === "undefined" || typeof window === "undefined") return null;
  return {
    at: Date.now(),
    projectId: app.currentProjectId ?? "",
    window: {
      width: window.innerWidth,
      height: window.innerHeight,
      focused: document.hasFocus(),
    },
    panes: panesOnScreen(),
    overlays: overlaysOnScreen(),
  };
}

/** Everything but the clock, which is what decides whether anything moved. */
export function shape(screen: Screen): string {
  const { at: _at, ...rest } = screen;
  return JSON.stringify(rest);
}

/** What was last sent, and when. */
export interface Sent {
  shape: string;
  at: number;
}

/**
 * Whether this description is worth writing down.
 *
 * Unchanged and recent: the window has already said this, and saying it again
 * is a write nobody reads. Past the heartbeat it says it anyway, which is what
 * turns `at` from a timestamp into proof the window is still answering.
 */
export function worthSending(last: Sent | null, next: Screen): boolean {
  if (!last) return true;
  if (shape(next) !== last.shape) return true;
  return next.at - last.at >= HEARTBEAT_MS;
}

/**
 * Keeps the description current, and returns the way to stop.
 *
 * Looks on a beat rather than watching the layout: the tree, the DOM rects, the
 * overlays and the focus are four sources, and a watcher on each is four places
 * for the one that matters to be missing. A description that is five seconds
 * behind is still the answer to every question this is asked.
 *
 * Nothing is sent while the window is hidden. A minimised workspace has nothing
 * to describe, and the heartbeat would be a write every thirty seconds for a
 * window nobody can see.
 */
export function watchScreen(): () => void {
  if (!hasTauri() || typeof document === "undefined") return () => {};

  let last: Sent | null = null;

  const look = () => {
    if (document.visibilityState !== "visible") return;
    const screen = describeScreen();
    if (!screen) return;
    if (!worthSending(last, screen)) return;
    last = { shape: shape(screen), at: screen.at };
    // The failure is already written down by the door this goes through, and a
    // window that cannot describe itself is not a window that should throw.
    void invoke("record_screen", { screen }).catch(() => {});
  };

  look();
  const timer = setInterval(look, LOOK_EVERY_MS);
  // Coming back into view is the one moment worth not waiting for: it is when
  // somebody has just started looking at a problem.
  document.addEventListener("visibilitychange", look);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", look);
  };
}
