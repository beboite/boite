import { app } from "$lib/app/store.svelte";
import { backend } from "$lib/backend";
import { paneStore, MAX_LEAVES, leafNodesOf, threadLeavesOf } from "./store.svelte";
import type { DropSide, PaneContent, PaneKind, PanelKind } from "./types";
import { notifications } from "$lib/features/notifications/store.svelte";
import { t } from "$lib/i18n/index.svelte";
import { log } from "$lib/shared/log";

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
 *
 * `anchor` is for the one caller that knows better than the screen does: an
 * agent asking for a pane beside its own terminal, which is very often not the
 * terminal the user is reading. Given one, **nothing here moves the view** —
 * no active thread, no selected project, no switch away from the project page.
 * The pane appears where it belongs and waits there, since every group stays
 * mounted whether or not it is the one being drawn.
 */
function trackPaneOpened(kind: PaneKind) {
  try {
    void backend().telemetry.trackPane(kind).catch(() => {});
  } catch {
    // Tests, or a backend that has no telemetry method.
  }
}

export function openPane(
  content: PaneContent,
  side: DropSide = "right",
  ratio = panelRatio(),
  anchor?: string | null,
): string | null {
  const paneId = openPaneInner(content, side, ratio, anchor);
  // Debug rather than info: a pane opens on a click, a keybinding, a palette
  // entry and an agent verb, several times a minute while somebody works, and
  // the question it answers ("what was on screen when the frame stalled") is a
  // debugging question.
  log.debug("ui.pane", paneId ? "pane.opened" : "pane.refused", {
    kind: content.kind,
    ...(paneId ? { pane: paneId } : {}),
  });
  return paneId;
}

function openPaneInner(
  content: PaneContent,
  side: DropSide,
  ratio: number,
  anchor?: string | null,
): string | null {
  const already = panePresence(content.kind);
  if (anchor) {
    const paneId = beside(anchor, content, side, ratio, false);
    if (paneId && !already) trackPaneOpened(content.kind);
    return paneId;
  }
  // A pane is part of the terminal view; opening one from the project page
  // would otherwise put it behind the page that asked for it.
  app.view = "terminal";
  // Beside the focused pane of the active group, which is the pane the user is
  // looking at. Falling back to the active thread covers the case where the
  // focus is on a panel the group index still knows about.
  const onScreen = anchorPaneId();
  if (onScreen) {
    const paneId = beside(onScreen, content, side, ratio, true);
    if (paneId && !already) trackPaneOpened(content.kind);
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
  const paneId = paneStore.openGroup(projectId, content);
  if (paneId && !already) trackPaneOpened(content.kind);
  return paneId;
}

/** The half the two anchors share, so the refusal reads the same either way. */
function beside(
  anchor: string,
  content: PaneContent,
  side: DropSide,
  ratio: number,
  focus: boolean,
): string | null {
  const paneId = paneStore.openBeside(anchor, content, side, ratio, focus);
  if (!paneId) notifications.error(t("panes.groupFull", { count: MAX_LEAVES }));
  return paneId;
}

/** What the rail was wide, and what a panel opens at. */
const PANEL_PX = 320;

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

/**
 * The pane in the active group showing this kind, if one is open.
 *
 * Answers for any singleton kind, not only the three panels: the editor asks it
 * to find out whether it already has a pane before falling back to covering the
 * window with itself.
 */
export function panePresence(kind: PaneKind): string | null {
  const anchor = anchorPaneId();
  if (!anchor) return null;
  const group = paneStore.groupOf(anchor);
  if (!group) return null;
  const leaf = leafNodesOf(group.root).find((l) => l.content.kind === kind);
  return leaf?.paneId ?? null;
}

/**
 * Close a panel's pane, wherever in the tree it ended up.
 *
 * A pane is the only home these three have now that the docked column is gone,
 * so this is the whole way out rather than a special case for a detached copy.
 */
export function closePanelPane(kind: PanelKind): boolean {
  const open = panePresence(kind);
  if (!open) return false;
  paneStore.closePane(open);
  return true;
}

/**
 * What the titlebar's Git, Fichiers and Todo buttons do, in one call.
 *
 * Three states rather than two, because a panel that is open is not necessarily
 * the panel you are looking at. Closed, it opens. Open and focused, a second
 * press closes it — which is what a toggle means. Open behind another pane, it
 * takes the focus: closing it there would answer a press aimed at a panel the
 * user cannot see with the panel disappearing, and the column this replaced had
 * no such case to get wrong.
 */
export function togglePanelPane(kind: PanelKind): void {
  const open = panePresence(kind);
  const group = open ? paneStore.groupOf(open) : null;
  if (!open || !group) {
    openPane({ kind });
    return;
  }
  if (group.focusedPaneId === open) {
    paneStore.closePane(open);
    return;
  }
  paneStore.setFocused(group.id, open);
}

/**
 * Close a pane from the phone's pane strip.
 *
 * The desktop closes a pane from the palette and never runs out of somewhere to
 * look: another pane is already beside it. A phone draws one pane at a time, so
 * closing the only one left drops the user on an empty Terminal tab with no way
 * back — the dead end the strip exists to remove. The project's overview takes
 * that slot, which is the phone's version of the welcome card the window shows
 * when nothing is running.
 *
 * Thread panes never come through here: the strip offers no close on one, since
 * removing a terminal from the group means moving it, not closing it, and the
 * terminals sheet already closes a thread with a confirmation.
 */
export function closeMobilePane(paneId: string): boolean {
  const group = paneStore.groupOf(paneId);
  if (!group) return false;
  const projectId = group.projectId;
  const last = leafNodesOf(group.root).length <= 1;
  if (!paneStore.closePane(paneId)) return false;
  if (last) paneStore.openGroup(projectId, { kind: "dashboard" });
  return true;
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
