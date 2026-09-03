import type { Settings } from "$lib/types";

export type HomeAvailabilitySettings = Pick<Settings, "experimentWorkspace">;

/**
 * Whether the home view may be reached at all on this device.
 *
 * One flag arms it, and the question stays a function rather than becoming a
 * field read at each call site: every entry point (the titlebar button, the
 * palette command, the mobile tab, the launch preference) asks this one, so the
 * surfaces cannot drift apart. They did, back when home and the orchestrator
 * were two switches — the conductor's chat is drawn inside home and nowhere
 * else, so a device that armed the orchestrator alone had a running
 * orchestrator it could never open.
 */
export function homeAvailable(settings: HomeAvailabilitySettings): boolean {
  return settings.experimentWorkspace;
}
