import { app } from "$lib/app/store.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { openPane } from "$lib/features/panes/open";
import { todoFocus } from "./focus.svelte";

/**
 * Put one card on screen, in whichever layout is up.
 *
 * Two, because the list has two homes and only one of them is drawn at a time:
 * a tab page on a phone, a pane leaf everywhere else. The docked column was a
 * third and is gone, which took with it the trap of setting a panel nothing
 * renders.
 */
export function openTodo(projectId: string, todoId: string) {
  app.selectedProjectId = projectId;
  app.view = "terminal";
  if (settings.state.mobileLayout) {
    app.mobileTab = "todo";
  } else {
    openPane({ kind: "todo" });
  }
  todoFocus.request(todoId);
}
