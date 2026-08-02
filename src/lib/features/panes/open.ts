import { app } from "$lib/app/store.svelte";
import { paneStore, MAX_LEAVES, leafNodesOf, threadLeavesOf } from "./store.svelte";
import type { DropSide, PaneContent, PanelKind } from "./types";
import { notifications } from "$lib/features/notifications/store.svelte";
import { t } from "$lib/i18n/index.svelte";

/**
 * The one way anything opens a pane.
 *
 * Splitting used to have exactly one entry point in the whole app — drag a
 * thread row from the sidebar onto a live terminal — with no shortcut, no
 * palette command, no menu item and no button. That is the other half of why
 * nobody used it: the feature worked, and could not be found. Everything that
 * wants a pane now comes through here: the keyboard, the palette, the titlebar,
 * and the MCP verb an agent calls to show what it just did.
 *
 * `ratio` is a share of the group, so a caller that wants a column says so with
 * `panelRatio()` rather than a number: 0.35 of a 2560px window is 900px of git
 * panel, where the rail this replaced was 320px whatever the screen.
 */
export function openPane(
  content: PaneContent,
  side: DropSide = "right",
  ratio = panelRatio(),
): string | null {
  // A pane is part of the terminal view; opening one from the project page
  // would otherwise put it behind the page that asked for it.
  app.view = "terminal";
  // Beside the focused pane of the active group, which is the pane the user is
  // looking at. Falling back to the active thread covers the case where the
  // focus is on a panel the group index still knows about.
  const anchor = anchorPaneId();
  if (anchor) {
    const paneId = paneStore.openBeside(anchor, content, side, ratio);
    if (!paneId) notifications.error(t("panes.groupFull", { count: MAX_LEAVES }));
    return paneId;
  }
  // Nothing open to sit beside. The rail this replaced drew git, files and the
  // todo list whether or not a terminal was running, so refusing here took the
  // panels away from every project the user had not launched anything in yet.
  const projectId = app.currentProjectId;
  if (!projectId) {
    notifications.error(t("panes.needProject"));
    return null;
  }
  return paneStore.openGroup(projectId, content);
}

/** What the rail was wide, and what a panel opens at. */
const PANEL_PX = 320;

const PANEL_KINDS: PanelKind[] = ["git", "explorer", "todo"];

/**
 * Takes the panel already on screen as the one to keep open.
 *
 * The toggle is not the only way one gets there: a layout restored at startup,
 * a palette command and an agent's own call all open a panel without saying it
 * should follow the user, and a panel that came back from the last session is
 * exactly the one they left open.
 */
function adoptVisiblePanel(): PanelKind | null {
  const anchor = anchorPaneId();
  const group = anchor ? paneStore.groupOf(anchor) : null;
  if (!group) return null;
  const leaf = leafNodesOf(group.root).find((l) =>
    PANEL_KINDS.includes(l.content.kind as PanelKind),
  );
  if (!leaf) return null;
  paneStore.stickyPanel = leaf.content.kind as PanelKind;
  return paneStore.stickyPanel;
}

/**
 * A panel's share of the group, taken from a width in pixels.
 *
 * Ratios are proportional, so the same number is a different panel on every
 * screen: what a user means by "the git panel" is a column beside their work,
 * not a third of the window. Falls back to a third of the group before the
 * viewport has been measured, which is one frame at startup.
 */
export function panelRatio(): number {
  const width = paneStore.viewport?.w ?? 0;
  if (width <= 0) return 0.3;
  return Math.min(0.6, Math.max(0.12, PANEL_PX / width));
}

/**
 * The pane a new one should appear beside, or null when nothing is on screen.
 *
 * Only ever a pane of the group the page is drawing. The page shows the active
 * thread's group, and with no active thread the project's panel group — the one
 * with no terminal in it. Anchoring anywhere else opened the panel into a group
 * nothing renders: the titlebar button lit up, the pane existed, and there was
 * nothing to see anywhere on screen.
 */
export function anchorPaneId(): string | null {
  const active = app.activeThreadId;
  if (active) {
    const group = paneStore.groupOf(active);
    if (group) return group.focusedPaneId;
  }
  const projectId = app.currentProjectId;
  const group = paneStore.groups.find(
    (g) => g.projectId === projectId && threadLeavesOf(g.root).length === 0,
  );
  return group?.focusedPaneId ?? null;
}

/**
 * The project a pane opened right now would land in.
 *
 * Everything else here reads the anchor and stops; this is for the one caller
 * that has to know whose window it is about to rearrange. An agent names the
 * project it is asking for, and the anchor is whatever the user happens to be
 * looking at, which is very often another one.
 */
export function anchorProjectId(): string | null {
  const anchor = anchorPaneId();
  const group = anchor ? paneStore.groupOf(anchor) : null;
  return group?.projectId ?? app.currentProjectId;
}

export type { PanelKind } from "./types";

/** The pane in the active group showing this panel, if one is open. */
export function panePresence(kind: PanelKind): string | null {
  const anchor = anchorPaneId();
  if (!anchor) return null;
  const group = paneStore.groupOf(anchor);
  if (!group) return null;
  const leaf = leafNodesOf(group.root).find((l) => l.content.kind === kind);
  return leaf?.paneId ?? null;
}

/**
 * Open the panel, or close it if it is already there.
 *
 * What the titlebar button does, and what the right rail used to do from a
 * fixed 320px column outside the layout. The difference is that this one is a
 * pane: it can be moved, resized against its neighbours, and put below a
 * terminal rather than always to the right of everything.
 */
export function togglePanelPane(kind: PanelKind): boolean {
  const open = panePresence(kind);
  if (open) {
    paneStore.closePane(open);
    if (paneStore.stickyPanel === kind) paneStore.stickyPanel = null;
    return false;
  }
  // Opened on purpose, so it stays open through a project switch: see
  // `followPanel`.
  paneStore.stickyPanel = kind;
  openPane({ kind });
  return true;
}

/**
 * Puts the open panel in the group now on screen.
 *
 * A pane belongs to a group and a group belongs to a project, so walking to
 * another project left the git panel behind in the group of the one before it
 * and the screen came back without it. The rail this replaced was outside the
 * layout and simply described whatever project you were on.
 *
 * Never touches `app.view`: this runs off a project switch, and a user reading
 * a project page did not ask to be sent to the terminal.
 */
export function followPanel(): void {
  const kind = paneStore.stickyPanel ?? adoptVisiblePanel();
  if (!kind) return;
  if (panePresence(kind)) return;
  const anchor = anchorPaneId();
  if (anchor) {
    paneStore.openBeside(anchor, { kind }, "right", panelRatio());
    return;
  }
  const projectId = app.currentProjectId;
  if (projectId) paneStore.openGroup(projectId, { kind });
}

/**
 * Split the focused pane with a copy of the active thread's neighbour.
 *
 * What `Ctrl+Shift+E` and `Ctrl+Shift+O` do: there is nothing obvious to put in
 * a new pane, so they offer the project's dashboard rather than refusing. A
 * user who wanted a second terminal has `Ctrl+T`, and dragging still does the
 * arbitrary case.
 */
export function splitFocused(side: DropSide): string | null {
  return openPane({ kind: "dashboard" }, side, 0.5);
}
