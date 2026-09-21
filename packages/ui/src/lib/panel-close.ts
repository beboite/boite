import { confirm } from './confirm.svelte';
import { baseName, type BoundPanel, type CloseAction } from './right-panel.svelte';
import { fill, strings } from './strings';

/**
 * Closes tabs the way the action says, asking first when one of them holds an
 * edit that was never saved. Closing a file tab drops its draft, and the tab
 * menu, the close button, the middle click and the close key all used to do it
 * without a word.
 */
export async function closeTabs(panel: BoundPanel, action: CloseAction, id: string | null): Promise<void> {
  const unsaved = panel.unsaved(panel.closing(action, id));
  if (unsaved.length > 0) {
    const only = unsaved.length === 1 ? unsaved[0] : undefined;
    const ok = await confirm.ask({
      title: only
        ? fill(strings.files.discardOne, { name: baseName(only.path ?? '') })
        : fill(strings.files.discardMany, { count: String(unsaved.length) }),
      body: strings.files.discardBody,
      confirmLabel: strings.files.discardConfirm,
      cancelLabel: strings.common.cancel,
      danger: true
    });
    if (!ok) return;
  }
  if (action === 'all') panel.closeAll();
  else if (id === null) return;
  else if (action === 'close') panel.close(id);
  else if (action === 'others') panel.closeOthers(id);
  else panel.closeToRight(id);
}
