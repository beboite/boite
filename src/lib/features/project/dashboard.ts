import { app } from "$lib/app/store.svelte";

/**
 * Put a project's overview on screen, in whichever layout is up.
 *
 * Two callers, one rule, because the two layouts disagree about what "on
 * screen" means and one of them got it wrong on its own. `view` is what the PC
 * window draws over the terminal; on a phone the bottom bar's tab pages are
 * drawn after those overlays and at the same depth, so any tab but `terminal`
 * covers the dashboard rather than sitting under it.
 *
 * The active thread is left behind for the same reason the sidebar leaves it:
 * the page is about the project, and a thread still marked active is a
 * terminal one keystroke away from being back in front of it.
 */
export function openProjectDashboard(projectId: string) {
  app.selectedProjectId = projectId;
  app.activeThreadId = null;
  app.view = "project";
  app.mobileTab = "terminal";
}
