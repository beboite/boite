import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
let url: string;
const id = (name: string) => `[data-testid="${name}"]`;
const notice = (provider: string) => `${id('harness-update-notice')}[data-update-provider="${provider}"]`;
async function settled() {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
}
async function capture(name: string) { await settled(); await page.screenshot(join(import.meta.dir, '.artifacts', name)); }
const desktop = () => page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
const phone = () => page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

beforeAll(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}/?fake=1&updates=1&open=recent`;
  server = await startUi(port);
}, 120_000);
beforeEach(async () => {
  page = await BrowserPage.launch({ url });
  await page.waitFor(`document.querySelector('${id('nav-settings')}')`);
  await desktop();
}, 30_000);
afterEach(async () => { await page?.close(); }, 15_000);
afterAll(async () => { await server?.close(); }, 15_000);

test('an agent update is a pinned notice with Update and Skip, on a desktop and on a phone', async () => {
  await page.waitFor(`document.querySelectorAll('${id('harness-update-notice')}').length === 2`);
  // Pinned to the top right corner, where neither the composer nor the sidebar is.
  const overlap = await page.evaluate(`(() => {
    const notices = document.querySelector('${id('harness-update-notices')}').getBoundingClientRect();
    const composer = document.querySelector('${id('composer')}').getBoundingClientRect();
    return { right: notices.right, top: notices.top, clear: notices.bottom <= composer.top };
  })()`) as { right: number; top: number; clear: boolean };
  expect(overlap.right).toBeGreaterThan(1400 - 32);
  expect(overlap.top).toBeLessThan(80);
  expect(overlap.clear).toBe(true);
  await capture('harness-updates-desktop.png');

  await phone();
  // One card at a time on a phone, under the header.
  expect(await page.evaluate(`[...document.querySelectorAll('${id('harness-update-notice')}')].filter(card => card.offsetParent !== null).length`)).toBe(1);
  expect(await page.evaluate(`document.documentElement.scrollWidth <= 390`)).toBe(true);
  await capture('harness-updates-phone.png');
  await desktop();

  // Skip takes this version off the screen and nothing else.
  await page.click(`${notice('claude')} ${id('harness-update-skip')}`);
  await page.waitFor(`document.querySelector('${notice('claude')}') === null`);
  expect(await page.evaluate(`document.querySelectorAll('${id('harness-update-notice')}').length`)).toBe(1);

  // Update turns the card into a progress card, then the core says it is current and the card leaves.
  await page.click(`${notice('codex')} ${id('harness-update-run')}`);
  await page.waitFor(`document.querySelector('${notice('codex')}')?.dataset.state === 'updating'`);
  await capture('harness-updates-updating.png');
  await page.waitFor(`document.querySelector('${id('harness-update-notices')}') === null`);
}, 20_000);

test('Settings, Providers lists every agent, offers a skipped version again and carries the automatic switch', async () => {
  await page.click(`${notice('claude')} ${id('harness-update-skip')}`);
  await page.waitFor(`document.querySelector('${notice('claude')}') === null`);
  await page.click(id('nav-settings')); await page.click(id('settings-tab-accounts'));
  await page.waitFor(`document.querySelectorAll('${id('harness-update-row')}').length === 4`);
  const text = await page.evaluate(`document.querySelector('${id('harness-updates-card')}').textContent`) as string;
  expect(text).toContain('2.1.278 skipped');
  expect(text).toContain('Up to date');
  // An agent that cannot name its newest release offers its updater instead of a version.
  expect(text).toContain('Checks by itself');
  expect(await page.evaluate(`document.querySelector('[data-update-provider="antigravity"] ${id('harness-update-row-blind')}') !== null`)).toBe(true);

  await page.click(id('setting-auto-update-harnesses'));
  await page.waitFor(`document.querySelector('${id('setting-auto-update-harnesses')}').checked`);
  await capture('harness-updates-settings.png');

  await page.click(id('harness-update-unskip'));
  await page.waitFor(`document.querySelector('${notice('claude')}') !== null`);

  await phone();
  // A phone's settings keep their one column to themselves.
  expect(await page.evaluate(`document.querySelector('${id('harness-update-notices')}').offsetParent === null`)).toBe(true);
  expect(await page.evaluate(`document.documentElement.scrollWidth <= 390`)).toBe(true);
  await capture('harness-updates-settings-phone.png');
  await desktop();
// Includes the first lazy Settings import and captures at both viewport sizes.
}, 20_000);
