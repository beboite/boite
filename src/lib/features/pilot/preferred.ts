import { settings } from "$lib/features/settings/store.svelte";
import { launchChat, launchShortcut } from "$lib/features/thread/api";
import { notifications } from "$lib/features/notifications/store.svelte";
import { t } from "$lib/i18n/index.svelte";
import type { Shortcut } from "$lib/types";
import { chatChoice, pilotCatalog } from "./catalog.svelte";
import { driverOfCommand } from "./launch";

export function prefersChat(command: string, enabled: boolean): boolean {
  return enabled && driverOfCommand(command) !== null;
}

/** Agent shortcuts open conversations; arbitrary commands still open terminals. */
export async function launchPreferredShortcut(shortcut: Shortcut, projectId: string | null) {
  if (!prefersChat(shortcut.command || shortcut.label, settings.state.experimentPilot)) {
    return launchShortcut(shortcut, projectId);
  }
  await pilotCatalog.ensure();
  if (!chatChoice(shortcut.command || shortcut.label).enabled) {
    notifications.error(t("pilot.noDriver"));
    return null;
  }
  return launchChat(shortcut, projectId);
}
