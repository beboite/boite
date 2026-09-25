import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';
// Vite belongs to the UI workspace, not the repository root.
let server: { close(): Promise<void> };
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
  server = await startDevUi(port);
  uiUrl = `http://127.0.0.1:${port}`;
  page = await BrowserPage.launch({ url: `${uiUrl}/?fake=1&open=recent` });
  await page.waitFor(`document.querySelector('${id('nav-settings')}')`);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('provider settings show login controls and quota monitoring', async () => {
  await page.click(id('nav-settings')); await page.click(id('settings-tab-accounts'));
  await page.waitFor(`document.querySelectorAll('${id('provider-settings')}').length > 1`);
  // The page opens as a checklist: one row and at most one next step per provider.
  expect(await page.evaluate(`[...document.querySelectorAll('${id('provider-settings')}')].every(row => row.querySelectorAll('.act .primary').length <= 1)`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('account-row')}') === null`)).toBe(true);
  await capture('providers.png');
  // Accounts, quotas and the uninstall sit behind each row's chevron.
  await page.evaluate(`document.querySelectorAll('${id('provider-details-toggle')}').forEach(button => button.click())`);
  await page.waitFor(`document.querySelector('${id('quota-monitor')}')`);
  await page.click(id('quota-monitor'));
  await page.waitFor(`!document.querySelector('${id('quota-monitor')}').checked`);
  expect(await page.evaluate(`document.querySelector('${id('accounts-page')}').textContent`)).toContain('Quota monitoring is off');
  await page.click(id('quota-monitor'));
  await capture('providers-details.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false });
  await capture('providers-details-narrow.png');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`document.querySelectorAll('${id('provider-details-toggle')}').forEach(button => button.click())`);
}, 30_000);

test('missing agents offer desktop setup while phone settings omit provider administration', async () => {
  await page.evaluate(`import('/src/lib/workspace.svelte.ts').then(({workspace}) => {
    workspace.active.providers = workspace.active.providers.map(p => ({...p, available: false, executable: null}));
    workspace.active.accounts = [];
  })`);
  await page.waitFor(`document.querySelector('[data-provider-id="claude"] a')`);
  expect(await page.evaluate(`document.querySelectorAll('${id('accounts-page')} button:disabled').length`)).toBe(0);
  expect(await page.evaluate(`!!document.querySelector('[data-provider-id="antigravity"] [data-testid="install-start"]')`)).toBe(true);
  await capture('providers-missing-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-home]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid=accounts-page]') === null`)).toBe(true);
  await capture('providers-missing-phone.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.click(id('providers-refresh'));
  await page.waitFor(`document.querySelector('[data-provider-id="claude"][data-step="sign-in"]')`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
}, 30_000);

test('installing a missing agent goes on to its sign-in without a second click or a terminal', async () => {
  await page.navigate(`${uiUrl}/?fake=1&open=recent&uninstalled=1`);
  await page.waitFor(`document.querySelector('${id('nav-settings')}')`);
  await page.click(id('nav-settings')); await page.click(id('settings-tab-accounts'));
  const connect = '[data-provider-id="claude"] [data-testid="install-start"]';
  const downloading = '[data-provider-id="claude"][data-install="downloading"]';
  await page.waitFor(`document.querySelector('${connect}')`);
  await capture('connect-fresh.png');
  await page.click(connect);
  await page.waitFor(`document.querySelector('${downloading}')`);
  await page.click('[data-provider-id="claude"] [data-testid="install-cancel"]');
  await page.waitFor(`document.querySelector('${connect}')`);
  expect(await page.evaluate(`document.querySelectorAll('[data-testid="account-login-row"]').length`)).toBe(0);
  await page.click(connect);
  await page.waitFor(`document.querySelector('${downloading}')`);
  await capture('connect-installing.png');
  await page.waitFor(`document.querySelector('[data-testid="account-login-row"] a')`);
  expect(await page.evaluate(`document.querySelector('[data-testid="account-login-row"] a').href`)).toContain('https://');
  await capture('connect-login.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-home]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid="account-row"]') === null`)).toBe(true);
  await capture('connect-login-phone.png');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
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
  await page.click(id('settings-tab-appearance'));
  await capture('providers-phone.png');
  expect(await page.evaluate(`document.querySelector('${id('settings')}').getBoundingClientRect().width`)).toBeLessThanOrEqual(390);
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
}, 30_000);

test('the compact quota page shows limits and reset times', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 460, deviceScaleFactor: 1, mobile: false });
  await page.navigate(`${uiUrl}/?fake=1&open=recent&view=quotas`);
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
  await page.navigate(`${uiUrl}/?fake=1&open=recent&machines=1`);
  await page.evaluate(`document.documentElement.dataset.theme = 'dark'`);
  await page.waitFor(`document.querySelectorAll('[data-machine-id="http://builder.test"] [data-testid="thread-row"]').length > 0`);
  await page.click(id('nav-settings'));
    await page.click(id('settings-tab-machines'));
  await page.waitFor(`document.querySelectorAll('[data-testid="machine-card"]').length === 2`);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('[data-testid="machine-rename"]')).map(input => input.value)`)).toContain('Builder');
  await capture('machines.png');
  await page.click(id('machine-remove'));
  await page.waitFor(`document.querySelector('${id('confirm-ok')}')`);
  await page.click(id('confirm-ok'));
  await page.waitFor(`document.querySelectorAll('[data-testid="machine-card"]').length === 1`);
}, 30_000);
