import { app } from "$lib/app/store.svelte";
import { backend } from "$lib/backend";
import { pushSupported } from "$lib/features/push/api";
import { platform } from "$lib/storage/platform.svelte";
import type { SettingCondition, SettingEntry, SettingsTabId } from "./catalogue";

/**
 * Which settings page is showing, and which control a jump asked to land on.
 *
 * The panel reads these; the palette and the settings search write them through
 * `goToSetting`. Keeping the tab here rather than in the panel is what lets a
 * command that is not the panel open a page and point at a row.
 */
class SettingsNav {
  tab = $state<SettingsTabId>("general");
  land = $state.raw<{ key: string } | null>(null);
}

export const settingsNav = new SettingsNav();

const CONDITIONS: Record<SettingCondition, () => boolean> = {
  push: pushSupported,
  windowsHost: () => platform.isHostWindows,
  pairing: () => backend().pairing !== null,
};

/** A catalogue entry this build actually draws. */
export function settingEntryVisible(entry: SettingEntry): boolean {
  return !entry.when || CONDITIONS[entry.when]();
}

/**
 * Open settings on the page an entry lives on, and ask the panel to point at it.
 *
 * The scroll and the highlight stay in the panel: the element does not exist
 * until that page is the one being drawn. This is the same function the
 * settings search uses.
 */
export function goToSetting(tab: SettingsTabId, key: string): void {
  app.view = "settings";
  app.mobileTab = "settings";
  settingsNav.tab = tab;
  settingsNav.land = { key };
}
