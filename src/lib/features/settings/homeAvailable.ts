import type { Settings } from "$lib/types";
import { orchestratorEnabledFor } from "./orchestratorEnabledFor";

export type HomeAvailabilitySettings = Pick<
  Settings,
  | "experimentHome"
  | "experimentOrchestrator"
  | "experimentOrchestratorPerProject"
  | "orchestratorAgent"
  | "orchestratorByProject"
>;

/**
 * Whether the home view may be reached at all on this device.
 *
 * Its own experiment arms it, and so does a live orchestrator: the conductor's
 * chat is drawn inside home and nowhere else, so a device that armed the
 * orchestrator alone had a running orchestrator it could never open. Every
 * entry point (the titlebar button, the palette command, the mobile tab, the
 * launch preference) asks this one question, so the surfaces cannot drift
 * apart again.
 */
export function homeAvailable(settings: HomeAvailabilitySettings): boolean {
  return settings.experimentHome || orchestratorEnabledFor(settings, null);
}
