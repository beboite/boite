import type { BrowserPage } from './cdp.ts';

/** Navigate through the phone's top menu, including when it is already open. */
export async function mobileAction(page: BrowserPage, destination: string): Promise<void> {
  if (!await page.evaluate(`!!document.querySelector('[data-testid=mobile-menu-dialog]')`)) {
    await page.click('[data-testid=mobile-menu]');
  }
  await page.click(`[data-testid=${destination}]`);
}
