import { classifyBrowserUrl } from "$lib/features/browser/url";
import { openPane } from "$lib/features/panes/open";
import { notifications } from "$lib/features/notifications/store.svelte";
import { t } from "$lib/i18n/index.svelte";

/**
 * Opens a typed address in a browser pane.
 *
 * Typing it is consent to see the page, not consent to frame the app's own
 * origin inside itself, so it goes through the same classifier an agent's
 * request does. Answers whether the palette should close: a refused address
 * leaves the box open with what was typed still in it, which is the one thing
 * the OS prompt this replaces could not do.
 */
export function openBrowserPane(typed: string): boolean {
  const raw = typed.trim();
  if (!raw) return false;
  const target = classifyBrowserUrl(raw);
  if (!target.ok) {
    notifications.error(t(`browser.refuse.${target.reason}`));
    return false;
  }
  openPane({ kind: "browser", url: target.url });
  return true;
}
