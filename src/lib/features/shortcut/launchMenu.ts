/**
 * The "where does this launch land" menu, shared by every launcher.
 *
 * Scratch is no longer a row to click, so asking for it has to be an action on
 * the thing being launched: right-click on the desktop, a long press on a
 * phone. The shortcut bar, the shell picker and the mobile launch sheet all
 * offer the same two answers, so they build them here rather than each
 * spelling out the same pair.
 */

import { app } from "$lib/app/store.svelte";
import { isScratch, projectDisplayName } from "$lib/features/project/scratch";
import { t } from "$lib/i18n/index.svelte";
import type { ContextMenuItem } from "$lib/shared/components/ContextMenu.svelte";

export function launchTargetMenu(
  launch: (forceScratch: boolean) => void,
): ContextMenuItem[] {
  const current = app.projects.find((p) => p.id === app.currentProjectId) ?? null;
  const items: ContextMenuItem[] = [];
  // Only worth offering when it is somewhere else: on Scratch already, or on
  // no project at all, both entries would do the same thing.
  if (current && !isScratch(current)) {
    items.push({
      label: t("shortcuts.launchIn", { project: projectDisplayName(current) }),
      action: () => launch(false),
    });
  }
  items.push({
    label: t("shortcuts.launchIn", { project: t("project.scratch") }),
    action: () => launch(true),
  });
  return items;
}
