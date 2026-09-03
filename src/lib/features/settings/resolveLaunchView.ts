import type { OpenOnLaunch, Settings } from "$lib/types";
import { homeAvailable, type HomeAvailabilitySettings } from "./homeAvailable";

/**
 * Where a launch should land, given the device settings.
 *
 * Home is gated on what can reach it: an `openOnLaunch` of `"home"` is ignored
 * while the workspace experiment is off, so a stored preference cannot open a
 * view that does not exist yet. `"last"` is returned as-is for the boot path to
 * keep doing what it already does.
 */
export function resolveLaunchView(
  settings: HomeAvailabilitySettings & Pick<Settings, "openOnLaunch">,
): OpenOnLaunch {
  if (!homeAvailable(settings)) return "project";
  return settings.openOnLaunch;
}
