import { app } from "$lib/app/store.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { openPane } from "$lib/features/panes/open";
import { todoFocus } from "./focus.svelte";

/**
 * Put one card on screen, in whichever layout is up.
 *
 * Three, because the list has three homes and only one of them is drawn at a
 * time: a tab page on a phone, the docked column on a PC, and a pane of its own
 * when the info-box experiment has taken the column away. Asking for the column
 * in that last case sets a panel nothing renders, which is the same trap the
 * palette's panel commands are already guarded against.
 */
export function openTodo(projectId: string, todoId: string) {
  app.selectedProjectId = projectId;
  app.view = "terminal";
  if (settings.state.mobileLayout) {
    app.mobileTab = "todo";
  } else if (settings.state.experimentInfoBox) {
    openPane({ kind: "todo" });
  } else {
    settings.setRightPanel(projectId, "todo");
  }
  todoFocus.request(todoId);
}
