import type { BrowserPage } from './cdp.ts';

/**
 * Lists the sidebar's threads by project or by recency. The choice sits in the
 * display options menu, which stays open on a choice, so this closes it again.
 * `prefix` is `mobile-` for the phone's thread list.
 */
export async function showThreadView(page: BrowserPage, view: 'projects' | 'recent', prefix = ''): Promise<void> {
  const trigger = `[data-testid=${prefix}grouping-options]`, menu = `[data-testid=${prefix}grouping-options-menu]`;
  if (await page.evaluate(`document.querySelector('${trigger}')?.getAttribute('aria-expanded') !== 'true'`)) await page.click(trigger);
  await page.click(`${menu} [data-value="view:${view}"]`);
  await page.waitFor(`document.querySelector('${menu} [data-value="view:${view}"]')?.getAttribute('aria-checked') === 'true'`);
  await page.click(trigger);
  await page.waitFor(`!document.querySelector('${menu}')`);
}
