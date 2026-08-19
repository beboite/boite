import type { OpenOnLaunch, Settings } from "$lib/types";

/**
 * Where a launch should land, given the device settings.
 *
 * Home is gated on the experiment: an `openOnLaunch` of `"home"` is ignored
 * while it is off, so a stored preference cannot open a view that does not
 * exist yet. `"last"` is returned as-is for the boot path to keep doing what
 * it already does.
 */
export function resolveLaunchView(
  settings: Pick<Settings, "experimentHome" | "openOnLaunch">,
): OpenOnLaunch {
  if (!settings.experimentHome) return "project";
  return settings.openOnLaunch;
}
