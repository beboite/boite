import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';

const uiRequire = createRequire(join(import.meta.dir, '../../packages/ui/package.json'));
const { createServer } = await import(uiRequire.resolve('vite'));
let server: { listen(): Promise<unknown>; close(): Promise<void> };
let page: BrowserPage;
let base: string;
const id = (name: string) => `[data-testid="${name}"]`;
const width = (value: number) => page.send('Emulation.setDeviceMetricsOverride', { width: value, height: 1000, deviceScaleFactor: 1, mobile: value < 720 });
async function capture(name: string) {
  await page.evaluate('document.fonts.ready');
  await page.evaluate('Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))');
  await page.screenshot(join(import.meta.dir, '.artifacts', `app-update-${name}.png`));
}
async function settings(phase: string, nightly = false) {
  await page.navigate(`${base}/?fake=1&appUpdate=${phase}${nightly ? '&appUpdateChannel=nightly&appUpdateCurrentChannel=nightly' : ''}`);
  await page.waitFor(`document.querySelector('${id('nav-settings')}')`);
  await page.click(id('nav-settings'));
  await page.waitFor(`document.querySelector('${id('app-update-card')}')`);
}

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = await createServer({ root: join(import.meta.dir, '../../packages/ui'), server: { host: '127.0.0.1', port, strictPort: true }, clearScreen: false });
  await server.listen();
  page = await BrowserPage.launch({ url: `${base}/?fake=1` });
  await width(1400);
}, 30_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('ready desktop updates show versions, notes and a restart confirmation', async () => {
  await settings('ready', true);
  await page.waitFor(`document.querySelector('${id('app-update-install')}')`);
  expect(await page.evaluate(`document.querySelector('${id('app-update-card')}').textContent`)).toContain('boite de nuit');
  expect(await page.evaluate(`document.querySelector('${id('app-update-card')}').textContent`)).toContain('Faster startup');
  await capture('ready-desktop');
  await page.click(id('app-update-install'));
  await page.waitFor(`document.querySelector('[role="alertdialog"], [role="dialog"]')`);
  expect(await page.evaluate(`document.querySelector('[role="alertdialog"], [role="dialog"]').textContent`)).toContain('Interrupted turns do not restart automatically');
  await capture('restart-confirmation');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.waitFor(`document.querySelector('[role="alertdialog"], [role="dialog"]') === null`);
  await page.click(id('app-update-stable'));
  await page.waitFor(`document.querySelector('${id('app-update-stable')}').getAttribute('aria-pressed') === 'true'`);
  expect(await page.evaluate(`document.querySelector('${id('app-update-card')}').textContent`)).toContain('boite de nuit');
  // Selecting a track does not mislabel the version currently running.
}, 30_000);

test('download progress and retry stay visible without overflowing a narrow desktop', async () => {
  await settings('downloading');
  expect(await page.evaluate(`document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')`)).toBe('38');
  await capture('downloading-desktop');
  await settings('error');
  await page.waitFor(`document.querySelector('${id('app-update-retry')}')`);
  await width(880);
  expect(await page.evaluate('document.documentElement.scrollWidth <= 880')).toBe(true);
  await capture('error-narrow');
  await page.click(id('app-update-retry'));
  await page.waitFor(`document.querySelector('${id('app-update-check')}')`);
}, 30_000);

test('phone and ordinary browser settings never offer native app installation', async () => {
  await page.navigate(`${base}/?fake=1`);
  await width(390);
  await page.waitFor(`document.querySelector('${id('nav-settings')}')`);
  await page.click(id('nav-settings'));
  await page.waitFor(`document.querySelector('${id('mobile-settings-home')}')`);
  expect(await page.evaluate(`document.querySelector('${id('app-update-card')}') === null`)).toBe(true);
  expect(await page.evaluate('document.documentElement.scrollWidth <= 390')).toBe(true);
  await capture('phone');
}, 30_000);
