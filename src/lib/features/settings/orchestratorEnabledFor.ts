import type { Settings } from "$lib/types";

/**
 * Whether the orchestrator watches a given project, from the settings alone.
 *
 * The order is the doctrine: the device must be armed, the workspace must name
 * an agent, and only then may a per-project override speak — and it only
 * speaks when the per-project experiment is itself armed, so switching that
 * flag off restores one global orchestrator without erasing the overrides.
 * `null` asks about the workspace as a whole, where no override applies.
 */
export function orchestratorEnabledFor(
  settings: Pick<
    Settings,
    | "experimentOrchestrator"
    | "experimentOrchestratorPerProject"
    | "orchestratorAgent"
    | "orchestratorByProject"
  >,
  projectId: string | null,
): boolean {
  if (!settings.experimentOrchestrator) return false;
  if (!settings.orchestratorAgent) return false;
  if (projectId && settings.experimentOrchestratorPerProject) {
    const own = settings.orchestratorByProject[projectId];
    if (own) return own === "on";
  }
  return true;
}
