import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
let url: string;
const button = '[data-testid="whip-button"]';
const toggle = '[data-testid="experiment-whip"]';

async function settled() {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations()
    .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))])`);
}

beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  url = `http://127.0.0.1:${port}/?fake=1&open=recent`;
  page = await BrowserPage.launch({ url });
  await page.waitFor('document.querySelector("[data-testid=nav-settings]")');
}, 60_000);

afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('the Whip experiment shows a bottom-left button, shakes the whole app and turns off immediately', async () => {
  expect(await page.evaluate(`document.querySelector('${button}') === null`)).toBe(true);
  await page.click('[data-testid=nav-settings]');
  await page.click('[data-testid=settings-tab-experiments]');
  // Fail promptly if the experiment is absent, rather than waiting for a click timeout.
  expect(await page.evaluate(`!!document.querySelector('${toggle}')`)).toBe(true);
  await page.click(toggle);
  await page.waitFor(`document.querySelector('${button}')`);
  await page.click('[data-testid=settings-back]');
  await settled();
  await page.screenshot(join(import.meta.dir, '.artifacts', 'whip-desktop.png'));
  await page.click(button);
  await page.waitFor(`getComputedStyle(document.getElementById('app')).transform !== 'none'`);
  await page.waitFor(`document.getElementById('app').getAnimations().length === 0`);
  expect(await page.evaluate(`getComputedStyle(document.getElementById('app')).transform`)).toBe('none');
  await page.navigate(url);
  await page.waitFor(`document.querySelector('${button}')`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor('document.querySelector("[data-testid=mobile-tabs]")');
  await settled();
  expect(await page.evaluate(`(() => {
    const rect = document.querySelector('${button}').getBoundingClientRect();
    const tabs = document.querySelector('[data-testid=mobile-tabs]').getBoundingClientRect();
    const composer = document.querySelector('[data-testid=composer]').getBoundingClientRect();
    return rect.left < 24 && rect.bottom <= tabs.top && composer.bottom <= rect.top && rect.width >= 44 && rect.height >= 44;
  })()`)).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'whip-phone.png'));
  await page.click(button);
  await page.waitFor(`document.getElementById('app').getAnimations().length > 0`);
  await page.waitFor(`document.getElementById('app').getAnimations().length === 0`);
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.click(button);
  expect(await page.evaluate(`document.getElementById('app').getAnimations().length`)).toBe(0);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.click('[data-testid=nav-settings]');
  await page.click('[data-testid=settings-tab-experiments]');
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await page.click(button);
  await page.waitFor(`document.getElementById('app').getAnimations().length > 0`);
  await page.click(toggle);
  await page.waitFor(`document.querySelector('${button}') === null`);
  expect(await page.evaluate(`document.getElementById('app').getAnimations().length`)).toBe(0);
  expect(await page.evaluate('JSON.parse(localStorage.getItem("boite.experiments")).includes("whip")')).toBe(false);
  expect(page.errors()).toEqual([]);
}, 30_000);
