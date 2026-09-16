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
}, 30_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

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

test('missing agents offer setup on desktop and phone, then redetection restores installed agents', async () => {
  await page.evaluate(`import('/src/lib/workspace.svelte.ts').then(({workspace}) => {
    workspace.active.providers = workspace.active.providers.map(p => ({...p, available: false, executable: null}));
    workspace.active.accounts = [];
  })`);
  await page.waitFor(`document.querySelector('[data-provider-id="claude"] a')`);
  expect(await page.evaluate(`document.querySelectorAll('.connect:disabled').length`)).toBe(0);
  expect(await page.evaluate(`!!document.querySelector('[data-provider-id="antigravity"] [data-testid="install-start"]')`)).toBe(true);
  await capture('providers-missing-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await capture('providers-missing-phone.png');
  await page.click(id('providers-refresh'));
  await page.waitFor(`document.querySelector('[data-provider-id="claude"] .connect')`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
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
  await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await page.waitFor(`document.querySelectorAll('${id('quota-provider')}').length === 5 && document.querySelector('progress')`);
  expect(await page.evaluate(`getComputedStyle(document.documentElement).backgroundColor`)).toBe('rgba(0, 0, 0, 0)');
  expect(await page.evaluate(`getComputedStyle(document.body).clipPath`)).toBe('inset(0px round 12px)');
  await capture('quota-popup.png');
  expect(await page.evaluate(`Array.from(document.querySelectorAll('${id('quota-provider')}')).map(el => el.dataset.provider)`)).toEqual(['claude', 'codex', 'antigravity', 'grok', 'opencode']);
  expect(await page.evaluate(`document.querySelector('${id('quota-popup')}').textContent`)).toContain('Resets');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.click('[data-provider="antigravity"] .summary');
  await page.click('[data-provider="antigravity"] input');
  await page.waitFor(`document.querySelector('[data-provider="antigravity"] progress')`);
  await page.click('[data-provider="antigravity"] input');
  await page.waitFor(`!document.querySelector('[data-provider="antigravity"] progress')`);
  await page.evaluate(`document.querySelector('[data-provider="antigravity"] input').scrollIntoView({ block: 'nearest' })`);
  await capture('quota-popup-setup.png');
  await page.click('[data-provider="antigravity"] .summary');
  expect(await page.evaluate(`document.querySelector('section').scrollWidth <= document.querySelector('section').clientWidth`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('section').scrollHeight <= document.querySelector('section').clientHeight`)).toBe(true);
  await page.evaluate(`document.documentElement.dataset.theme = 'light'`);
  await capture('quota-popup-light.png');
  await page.evaluate(`document.documentElement.dataset.theme = 'grain'`);
  await capture('quota-popup-grain.png');
  expect(await page.evaluate(`getComputedStyle(document.documentElement).backgroundColor`)).toBe('rgba(0, 0, 0, 0)');
}, 30_000);

test('machines list each execution host and disconnect only the selected host', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.navigate(`${uiUrl}/?fake=1&machines=1`);
  await page.evaluate(`document.documentElement.dataset.theme = 'dark'`);
  await page.waitFor(`document.querySelectorAll('[data-machine-id="http://builder.test"] [data-testid="thread-row"]').length > 0`);
  await page.click(id('nav-settings'));
    await page.click(id('settings-tab-machines'));
  await page.waitFor(`document.querySelectorAll('[data-testid="machine-card"]').length === 2`);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('[data-testid="machine-rename"]')).map(input => input.value)`)).toContain('Builder');
  await capture('machines.png');
  await page.click(id('machine-remove'));
  await page.waitFor(`document.querySelectorAll('[data-testid="machine-card"]').length === 1`);
}, 30_000);
