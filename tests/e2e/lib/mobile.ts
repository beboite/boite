import type { BrowserPage } from './cdp.ts';

/** From a conversation, whose header holds no menu, Back leads to the list that has it. */
async function toList(page: BrowserPage): Promise<void> {
  if (await page.evaluate(`!!document.querySelector('[data-testid=mobile-menu]')`)) return;
  await page.click('[data-testid=mobile-back]');
  await page.waitFor(`document.querySelector('[data-testid=mobile-menu]')`);
}

/** Opens the phone's top menu, from the list or a page that has it. */
export async function openMobileMenu(page: BrowserPage): Promise<void> {
  await toList(page);
  await page.click('[data-testid=mobile-menu]');
}

/** Navigate through the phone's top menu, including when it is already open. */
export async function mobileAction(page: BrowserPage, destination: string): Promise<void> {
  if (!await page.evaluate(`!!document.querySelector('[data-testid=mobile-menu-dialog]')`)) await openMobileMenu(page);
  await page.click(`[data-testid=${destination}]`);
}

/** A new draft from the header's +, which the list shows. */
export async function newMobileThread(page: BrowserPage): Promise<void> {
  await toList(page);
  await page.click('[data-testid=mobile-header] [data-testid=mobile-new]');
}

/** The panel from a conversation's title menu, the one menu of its header. */
export async function openMobilePanel(page: BrowserPage): Promise<void> {
  await page.click('[data-testid=thread-menu-trigger]');
  await page.waitFor(`document.querySelector('[data-testid=thread-menu-trigger-menu] [data-value=panel]')`);
  await page.click('[data-testid=thread-menu-trigger-menu] [data-value=panel]');
  await page.waitFor(`document.querySelector('[data-testid=right-panel]')`);
}

/** Limits, once Settings is open: a desktop tab, or on a phone the second tab of the Usage screen. */
export async function openLimitsTab(page: BrowserPage): Promise<void> {
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-home], [data-testid=mobile-settings-detail], [data-testid=settings-tab-limits]')`);
  if (await page.evaluate(`!!document.querySelector('[data-testid=settings-tab-limits]')`)) {
    await page.click('[data-testid=settings-tab-limits]');
    return;
  }
  if (!await page.evaluate(`!!document.querySelector('[data-testid=mobile-usage-tab-limits]')`)) await page.click('[data-testid=settings-tab-usage]');
  await page.click('[data-testid=mobile-usage-tab-limits]');
}
