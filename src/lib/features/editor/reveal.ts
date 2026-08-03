import { app } from "$lib/app/store.svelte";
import { paneStore } from "$lib/features/panes/store.svelte";
import { panePresence } from "$lib/features/panes/open";

/**
 * Put the editor where the user can see it, after a file or a diff was opened.
 *
 * The editor has two homes — a pane in the tree, and the full-area view — and
 * every caller used to pick the second one outright. So opening a file from the
 * files panel covered the editor pane you already had open beside your terminal
 * with a second copy of itself, full screen, showing the same buffer.
 *
 * The rule is: if an editor pane is already up, that is where the file goes.
 * Nothing moves, nothing is covered, and the pane simply switches tab. Only
 * when there is no pane does the full-area view come up.
 */
export function revealEditor(): void {
  const pane = panePresence("editor");
  if (pane) {
    const group = paneStore.groupOf(pane);
    if (group) group.focusedPaneId = pane;
    app.view = "terminal";
    return;
  }
  app.view = "editor";
}
