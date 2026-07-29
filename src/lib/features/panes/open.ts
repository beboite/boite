import { app } from "$lib/app/store.svelte";
import { paneStore, MAX_LEAVES, leafNodesOf } from "./store.svelte";
import type { DropSide, PaneContent } from "./types";
import { notifications } from "$lib/features/notifications/store.svelte";
import { t } from "$lib/i18n/index.svelte";

/**
 * The one way anything opens a pane.
 *
 * Splitting used to have exactly one entry point in the whole app — drag a
 * thread row from the sidebar onto a live terminal — with no shortcut, no
 * palette command, no menu item and no button. That is the other half of why
 * nobody used it: the feature worked, and could not be found. Everything that
 * wants a pane now comes through here: the keyboard, the palette, the pane
 * header, and the MCP verb an agent calls to show what it just did.
 */
export function openPane(
  content: PaneContent,
  side: DropSide = "right",
  ratio = 0.35,
): string | null {
  // Beside the focused pane of the active group, which is the pane the user is
  // looking at. Falling back to the active thread covers the case where the
  // focus is on a panel the group index still knows about.
  const anchor = anchorPaneId();
  if (!anchor) {
    notifications.error(t("panes.needThread"));
    return null;
  }
  // A pane is part of the terminal view; opening one from the project page
  // would otherwise put it behind the page that asked for it.
  app.view = "terminal";
  const paneId = paneStore.openBeside(anchor, content, side, ratio);
  if (!paneId) notifications.error(t("panes.groupFull", { count: MAX_LEAVES }));
  return paneId;
}

/** The pane a new one should appear beside, or null when nothing is open. */
export function anchorPaneId(): string | null {
  const active = app.activeThreadId;
  if (active) {
    const group = paneStore.groupOf(active);
    if (group) return group.focusedPaneId;
  }
  // No active thread: any group of the selected project will do, and the user
  // sees the one they left focused.
  const projectId = app.currentProjectId;
  const group = paneStore.groups.find((g) => g.projectId === projectId);
  return group?.focusedPaneId ?? null;
}

/** Panel kinds the titlebar button can toggle. The three the right rail held. */
export type PanelKind = "git" | "explorer" | "todo";

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
    return false;
  }
  openPane({ kind });
  return true;
}

/**
 * Split the focused pane with a copy of the active thread's neighbour.
 *
 * What `Ctrl+\` does: there is nothing obvious to put in a new pane, so it
 * offers the project's dashboard rather than refusing. A user who wanted a
 * second terminal has `Ctrl+T`, and dragging still does the arbitrary case.
 */
export function splitFocused(side: DropSide): string | null {
  return openPane({ kind: "dashboard" }, side, 0.5);
}
