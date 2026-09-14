import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { BrowserPage, freePort } from './lib/cdp.ts';
// Vite belongs to the UI workspace, not the repository root.
const uiRequire = createRequire(join(import.meta.dir, '../../packages/ui/package.json'));
const { createServer } = await import(uiRequire.resolve('vite'));
let server: { listen(): Promise<unknown>; close(): Promise<void> };
let uiUrl: string;
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;
async function settled() {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
}
async function capture(name: string) { await settled(); await page.screenshot(join(import.meta.dir, '.artifacts', name)); }
beforeAll(async () => {
  // The fake client is deliberately absent from production bundles.
  const port = await freePort();
  server = await createServer({ root: join(import.meta.dir, '../../packages/ui'), server: { host: '127.0.0.1', port, strictPort: true }, clearScreen: false });
  await server.listen();
  uiUrl = `http://127.0.0.1:${port}`;
  page = await BrowserPage.launch({ url: `${uiUrl}/?fake=1` });
  await page.waitFor(`document.querySelector('${id('nav-settings')}')`);
});
afterAll(async () => { await page?.close(); await server?.close(); });

test('provider settings show login controls and quota monitoring', async () => {
  await page.click(id('nav-settings')); await page.click(id('settings-tab-accounts'));
  await page.waitFor(`document.querySelector('${id('quota-monitor')}')`);
  expect(await page.evaluate(`document.querySelectorAll('${id('provider-settings')}').length`)).toBeGreaterThan(1);
  await page.click(id('quota-monitor'));
  await page.waitFor(`!document.querySelector('${id('quota-monitor')}').checked`);
  expect(await page.evaluate(`document.querySelector('${id('accounts-page')}').textContent`)).toContain('Quota monitoring is off');
  await page.click(id('quota-monitor'));
  await capture('providers.png');
}, 30_000);

test('a plugin installs, switches an account and uninstalls through its page', async () => {
  await page.click(id('settings-tab-plugins'));
  await page.waitFor(`document.querySelector('${id('plugin-install')}') && !document.querySelector('${id('plugin-install')}').disabled`);
  await page.click(id('plugin-install'));
  await page.waitFor(`document.querySelectorAll('${id('plugin-pool')}').length === 3`);
  await capture('plugins.png');
  const row = `${id('plugin-pool')}[data-provider="claude"] ${id('plugin-account')}[data-email="personal@example.com"]`;
  await page.click(`${row} ${id('plugin-switch')}`);
  await page.waitFor(`document.querySelector('${id('confirm-ok')}')`); await page.click(id('confirm-ok'));
  await page.waitFor(`document.querySelector('${row} ${id('plugin-switch')}').disabled`);
  await page.click(id('plugin-uninstall')); await page.waitFor(`document.querySelector('${id('confirm-ok')}')`); await page.click(id('confirm-ok'));
  await page.waitFor(`document.querySelector('${id('plugin-install')}')`);
}, 30_000);

test('Grain is visible above solid and acrylic surfaces and the settings fit a phone', async () => {
  await page.click(id('settings-tab-experiments')); await page.click(id('experiment-theme-grain'));
  await page.click(id('settings-tab-appearance')); await page.click(id('theme-grain'));
  await page.click(id('settings-back'));
  await page.waitFor(`document.documentElement.dataset.theme === 'grain'`);
  await capture('grain-after.png');
  await page.evaluate(`document.documentElement.dataset.glass = 'acrylic'`);
  await capture('grain-acrylic.png');
  expect(await page.evaluate(`getComputedStyle(document.body, '::after').pointerEvents`)).toBe('none');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`document.querySelector('${id('nav-settings')}').click()`);
  await page.click(id('settings-tab-accounts'));
  await capture('providers-phone.png');
  expect(await page.evaluate(`document.querySelector('${id('settings')}').getBoundingClientRect().width`)).toBeLessThanOrEqual(390);
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
}, 30_000);

test('the compact quota page shows limits and reset times', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 460, deviceScaleFactor: 1, mobile: false });
  await page.navigate(`${uiUrl}/?fake=1&view=quotas`);
  await page.waitFor(`document.querySelector('${id('quota-account')}')`);
  await capture('quota-popup.png');
  expect(await page.evaluate(`document.querySelector('${id('quota-popup')}').textContent`)).toContain('Resets');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
}, 30_000);

test('remembered cores list every core and forget drops one', async () => {
  await page.evaluate(`localStorage.setItem('boite.envs', JSON.stringify([
    { url: 'http://127.0.0.1:9', label: 'cet ordi', token: 'x', paired: false },
    { url: 'http://100.64.0.15:3773', label: '100.64.0.15:3773', token: 'y', paired: true }
  ]))`);
  await page.navigate(`${uiUrl}/?fake=1`);
  await page.waitFor(`document.querySelector('${id('nav-settings')}')`);
  await page.click(id('nav-settings'));
  await page.waitFor(`document.querySelector('${id('settings-envs')}')`);
  const text = await page.evaluate(`document.querySelector('${id('settings-envs')}').textContent`);
  expect(text).toContain('cet ordi');
  expect(text).toContain('100.64.0.15:3773');
  await page.evaluate(`document.querySelector('${id('settings-envs')}').scrollIntoView({ block: 'center' })`);
  await capture('envs.png');
  await page.evaluate(`[...document.querySelectorAll('${id('settings-env-forget')}')][1].click()`);
  await page.waitFor(`document.querySelectorAll('${id('settings-envs')} li').length === 1`);
}, 30_000);
