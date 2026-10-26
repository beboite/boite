import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';
let server: { close(): Promise<void> };
let page: BrowserPage;
beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, showTour: true });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.waitFor(`document.querySelector('[data-testid="nav-settings"]')`);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);
const card = '[data-testid="telemetry-settings"]';
test('owner controls consent on desktop and phone; captures both layouts', async () => {
  await page.waitFor(`document.querySelector('[data-testid="onboarding-next"]')`);
  await page.click('[data-testid="onboarding-dot-privacy"]');
  await page.waitFor(`document.querySelector('[data-testid="onboarding-telemetry-enhanced"]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid="telemetry-choice-notice"]').textContent`)).toContain('without an installation ID');
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => { a.finish(); return a.finished.catch(() => {}); })])`);
  await page.screenshot(join(import.meta.dir, '.artifacts/onboarding-telemetry-desktop.png'));
  // Consent uses the panel's height: the last action must not float above a blank strip.
  const desktopBottomGap = await page.evaluate<number>(`(() => {
    const footer = document.querySelector('[data-testid="onboarding"] footer').getBoundingClientRect();
    const details = document.querySelector('[data-testid="telemetry-deal"] > button.link').getBoundingClientRect();
    return footer.top - details.bottom;
  })()`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.click('[data-testid="onboarding-dot-welcome"]');
  await page.click('[data-testid="onboarding-locale-fr"]');
  await page.click('[data-testid="onboarding-dot-privacy"]');
  await page.waitFor(`document.querySelector('[data-testid="onboarding-telemetry-enhanced"]')`);
  await page.waitFor(`document.querySelector('[data-testid="telemetry-choice-notice"]')?.textContent.includes("sans identifiant d'installation")`);
  expect(await page.evaluate(`document.querySelector('[data-testid="telemetry-choice-notice"]').textContent`)).toContain("sans identifiant d'installation");
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => { a.finish(); return a.finished.catch(() => {}); })])`);
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  expect(await page.evaluate(`(() => { const panel = document.querySelector('[data-testid="onboarding"] .panel').getBoundingClientRect(); const row = document.querySelector('[data-testid="onboarding-telemetry-enhanced"]').getBoundingClientRect(); return row.left >= panel.left && row.right <= panel.right; })()`)).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts/onboarding-telemetry-phone-fr.png'));
  // A choice below the scroll boundary is hidden even when the panel itself fits.
  expect(await page.evaluate(`(() => {
    const screen = document.querySelector('[data-testid="onboarding-step"]').getBoundingClientRect();
    return ['basic', 'enhanced', 'off'].every(mode => {
      const row = document.querySelector('[data-testid="onboarding-telemetry-' + mode + '"]').getBoundingClientRect();
      return row.top >= screen.top && row.bottom <= screen.bottom;
    });
  })()`)).toBe(true);
  expect(desktopBottomGap).toBeLessThanOrEqual(32);
  await page.click('[data-testid="onboarding-skip"]');
  await page.waitFor(`!document.querySelector('[data-testid="onboarding"]')`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.click('[data-testid="nav-settings"]');
  await page.click('[data-testid="settings-tab-general"]');
  await page.waitFor(`document.querySelector('${card} input')`);
  expect(await page.evaluate(`document.querySelector('${card} [data-testid="telemetry-choice-notice"]').textContent`)).toContain("sans identifiant d'installation");
  expect(await page.evaluate(`Array.from(document.querySelectorAll('${card} input')).map(x => x.checked)`)).toEqual([true, false]);
  await page.click(`${card} input`);
  await page.waitFor(`!document.querySelector('${card} input').checked`);
  await page.evaluate(`document.querySelectorAll('${card} input')[1].click()`);
  await page.waitFor(`document.querySelectorAll('${card} input')[1].checked`);
  await page.evaluate(`document.querySelector('${card}').scrollIntoView(); document.fonts.ready`);
  await page.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
  await page.screenshot(join(import.meta.dir, '.artifacts/telemetry-desktop.png'));
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor(`document.querySelector('[data-testid="mobile-settings-privacy"]')`);
  await page.click('[data-testid="mobile-settings-privacy"]');
  await page.waitFor(`document.querySelector('${card} input')`);
  await page.evaluate(`document.querySelector('${card}').scrollIntoView(); document.fonts.ready`);
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts/telemetry-phone.png'));
  await page.click(`${card} input`);
  await page.waitFor(`Array.from(document.querySelectorAll('${card} input')).every(x => !x.checked)`);
  await page.waitFor(`!document.querySelectorAll('${card} input')[1].disabled && document.querySelector('${card} .actions button')`);
  await page.click(`${card} .actions button`);
  await page.waitFor(`!document.querySelectorAll('${card} input')[1].disabled && !document.querySelector('${card} .actions button')`);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('${card} input')).map(x => x.checked)`)).toEqual([false, false]);
}, 30_000);
