/*
 * A button's right click: put it away, or go and choose among all of them.
 * The ids and what a device hides live in `work-prefs.svelte.ts`; the page's
 * catalogue, names and icons included, in `control-groups.ts`. This file stays
 * small because the header and the sidebar load it with the app.
 */
import { contextMenu } from './context-menu.svelte';
import { strings } from './strings';
import type { Store } from './store.svelte';
import { work, type ControlId } from './work-prefs.svelte';

/** The settings section the page draws the buttons in; a button's right click leads there. */
export const CONTROLS_SECTION = 'buttons';

export function controlMenu(event: MouseEvent, store: Store, id: ControlId): void {
  contextMenu.open(
    event,
    [
      { id: 'hide', label: strings.controls.hide },
      { id: 'customize', label: strings.controls.customize }
    ],
    (action) => {
      if (action === 'hide') work.show(id, false);
      else store.showSettings('appearance', CONTROLS_SECTION);
    }
  );
}
