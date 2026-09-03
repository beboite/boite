import type { Settings } from "$lib/types";

/**
 * Whether the orchestrator watches a given project, from the settings alone.
 *
 * The order is the doctrine: the device must be armed, the workspace must name
 * an agent, and only then may a per-project override speak. `null` asks about
 * the workspace as a whole, where no override applies.
 */
export function orchestratorEnabledFor(
  settings: Pick<
    Settings,
    "experimentWorkspace" | "orchestratorAgent" | "orchestratorByProject"
  >,
  projectId: string | null,
): boolean {
  if (!settings.experimentWorkspace) return false;
  if (!settings.orchestratorAgent) return false;
  if (projectId) {
    const own = settings.orchestratorByProject[projectId];
    if (own) return own === "on";
  }
  return true;
}
