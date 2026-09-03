import { app } from "$lib/app/store.svelte";
import { workspace } from "$lib/backend";
import { addProjectByPath } from "$lib/features/project/api";
import { homeAvailable } from "$lib/features/settings/homeAvailable";
import { settings } from "$lib/features/settings/store.svelte";
import { launchBlankTerminal } from "$lib/features/thread/api";

function showTerminal() {
  app.view = "terminal";
  app.mobileTab = "terminal";
}

function showHome() {
  app.view = "home";
  app.mobileTab = "home";
}

/**
 * What the titlebar logo does, and what the Home keybinding and palette row call.
 *
 * Home armed: open it, or leave it for the terminal. Otherwise the older logo
 * behaviour: back from settings, or a terminal at the remote workspace root.
 * Local with Home off is a no-op, which is also what keeps a keybinding from
 * throwing on a phone that never armed the experiment.
 */
export async function goHome(): Promise<void> {
  if (homeAvailable(settings.state)) {
    if (app.view === "home") showTerminal();
    else showHome();
    return;
  }
  if (app.view === "settings") {
    showTerminal();
    return;
  }
  if (workspace.mode === "local") return;
  const root = await workspace
    .backendFor("remote")
    .scope.workspaceRoot()
    .catch(() => null);
  if (!root) return;
  const project = await addProjectByPath(
    root,
    workspace.isDynamic ? "remote" : undefined,
  );
  if (project) await launchBlankTerminal(project.id);
}
