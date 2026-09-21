import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: Awaited<ReturnType<typeof startUi>>;
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;
async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}
beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent` });
  await page.waitFor(`document.querySelector('${id('nav-settings')}')`);
}, 30_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('configure, inspect, synchronize and disconnect a brain at desktop and phone widths', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1100, deviceScaleFactor: 1, mobile: false });
  await page.click(id('nav-settings'));
  await page.click(id('settings-tab-brain'));
  await page.waitFor(`document.querySelector('${id('brain-page')}')?.getAttribute('aria-busy') === 'false'`);
  expect(await page.evaluate(`document.querySelector('${id('brain-page')}').textContent`)).toContain('Choose an existing brain folder');
  await page.type(id('brain-path'), '/work/shared-brain');
  await page.click(id('brain-save'));
  await page.waitFor(`document.querySelectorAll('${id('brain-entry')}').length === 3`);
  expect(await page.evaluate(`document.querySelector('${id('brain-inventory')}').textContent`)).toContain('Plugin manifests are detected only');
  await capture('brain-desktop.png');
  await page.click(id('brain-sync'));
  await page.waitFor(`document.querySelector('${id('brain-last-sync')}')?.textContent.includes('Last synchronized')`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor(`document.querySelector('${id('brain-inventory')}')`);
  expect(await page.evaluate('document.documentElement.scrollWidth <= 390')).toBe(true);
  await capture('brain-phone.png');
  await page.click(id('brain-disconnect'));
  await page.waitFor(`document.querySelector('${id('brain-inventory')}') === null`);
  expect(await page.evaluate(`document.querySelector('${id('brain-path')}').value`)).toBe('');
  await page.type(id('brain-path'), 'relative');
  await page.click(id('brain-save'));
  await page.waitFor(`document.querySelector('${id('brain-error')}')`);
  expect(await page.evaluate(`document.querySelector('${id('brain-error')}').textContent`)).toContain('absolute');
  await capture('brain-phone-error.png');
}, 30_000);
