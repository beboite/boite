import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

const artifacts = join(import.meta.dir, '.artifacts', 'plugins');
let server: { close(): Promise<void> };
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;
const row = (plugin: string) => `${id('plugin-row')}[data-plugin="${plugin}"]`;

async function settled() {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
}
async function capture(name: string) { await settled(); await page.screenshot(join(artifacts, name)); }
/** The left 390 pixels of the viewport: the page laid out in a phone-wide column. */
async function captureColumn(name: string) {
  await settled();
  const raw = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 390, height: 844, scale: 1 } }) as { data?: string };
  if (typeof raw.data !== 'string') throw new Error('the screenshot came back empty');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, name), Buffer.from(raw.data, 'base64'));
}
async function scrollTo(selector: string) {
  await page.evaluate(`document.querySelector('${selector}').scrollIntoView({ block: 'start' })`);
}
async function inspect(url: string) {
  await page.type(id('plugin-url'), url);
  await page.click(id('plugin-inspect'));
  await page.waitFor(`document.querySelector('${id('plugin-preview')}')`);
}

beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1`, windowSize: { width: 1280, height: 800 } });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await page.waitFor(`document.querySelector('${id('nav-settings')}')`);
  await page.click(id('nav-settings'));
  await page.click(id('settings-tab-plugins'));
  await page.waitFor(`document.querySelector('${row('pool-legacy')}')`);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('the page lists installed plugins, then the recommended ones, then the URL form, every state visible', async () => {
  const sectionOf = (plugin: string) => page.evaluate<string>(`document.querySelector('${row(plugin)}').closest('section').dataset.testid`);
  expect(await sectionOf('seat-pool')).toBe('plugins-installed');
  expect(await sectionOf('grok-seats')).toBe('plugins-installed');
  expect(await sectionOf('pool-legacy')).toBe('plugins-installed');
  expect(await sectionOf('kebacc-switcher')).toBe('plugins-recommended');
  expect(await page.evaluate(`document.querySelector('${row('grok-seats')} ${id('plugin-progress')}').getAttribute('aria-valuenow')`)).toBe('45');
  expect(await page.evaluate(`document.querySelector('${row('pool-legacy')} ${id('plugin-rejected')}').dataset.field`)).toBe('manifest.schema');
  await page.waitFor(`document.querySelector('${row('seat-pool')} ${id('plugin-pool')}[data-provider="opencode"]')`);
  await capture('plugins-desktop.png');
  await scrollTo(id('plugins-recommended'));
  await capture('plugins-desktop-lower.png');
}, 30_000);

test('a URL shows its manifest before anything installs, and a refused one says why', async () => {
  await inspect('https://github.com/example/pi-pool');
  expect(await page.text(id('plugin-artifact'))).toBe('https://github.com/example/pi-pool/releases/download/v1.5.0/pi-pool-win32-x64.exe');
  expect(await page.evaluate(`document.querySelector('${row('pi-pool')}') === null`)).toBe(true);
  await scrollTo(id('plugins-add'));
  await capture('plugins-preview-desktop.png');

  await inspect('https://github.com/example/broken-pool');
  await page.waitFor(`document.querySelector('${id('plugin-preview')}').dataset.rejected === 'true'`);
  expect(await page.evaluate(`document.querySelector('${id('plugin-preview')} ${id('plugin-rejected')}').dataset.field`)).toBe('artifacts.win32-x64.sha256');
  expect(await page.evaluate(`document.querySelector('${id('plugin-add')}') === null`)).toBe(true);
  await scrollTo(id('plugins-add'));
  await capture('plugins-refused-desktop.png');

  await inspect('https://github.com/example/pi-pool');
  await page.click(id('plugin-add'));
  await page.waitFor(`document.querySelector('${row('pi-pool')}')?.dataset.status === 'installed'`);
  expect(await page.evaluate(`document.querySelector('${row('pi-pool')}').closest('section').dataset.testid`)).toBe('plugins-installed');
  await page.click(`${row('pi-pool')} ${id('plugin-uninstall')}`);
  await page.waitFor(`document.querySelector('${id('confirm-ok')}')`); await page.click(id('confirm-ok'));
  await page.waitFor(`document.querySelector('${row('pi-pool')}') === null`);
}, 30_000);

test('the recommended plugin installs, switches an account and uninstalls back to Recommended', async () => {
  await page.click(`${row('kebacc-switcher')} ${id('plugin-install')}`);
  await page.waitFor(`document.querySelectorAll('${row('kebacc-switcher')} ${id('plugin-pool')}').length === 3`);
  expect(await page.evaluate(`document.querySelector('${row('kebacc-switcher')}').closest('section').dataset.testid`)).toBe('plugins-installed');
  const account = `${row('kebacc-switcher')} ${id('plugin-pool')}[data-provider="claude"] ${id('plugin-account')}[data-email="personal@example.com"]`;
  await page.click(`${account} ${id('plugin-switch')}`);
  await page.waitFor(`document.querySelector('${id('confirm-ok')}')`); await page.click(id('confirm-ok'));
  await page.waitFor(`document.querySelector('${account} ${id('plugin-switch')}').disabled`);
  await scrollTo(row('kebacc-switcher'));
  await capture('plugins-installed-desktop.png');
  await page.click(`${row('kebacc-switcher')} ${id('plugin-uninstall')}`);
  await page.waitFor(`document.querySelector('${id('confirm-ok')}')`); await page.click(id('confirm-ok'));
  await page.waitFor(`document.querySelector('${row('kebacc-switcher')}')?.closest('section')?.dataset.testid === 'plugins-recommended'`);
}, 30_000);

test('in a 390 pixel column the page wraps instead of scrolling sideways', async () => {
  // The desktop shell never gets this narrow and the phone has its own settings,
  // so the column is made here: the nav hidden, the page 390 pixels wide.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 844, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`(() => {
    const style = document.createElement('style');
    style.id = 'plugins-column';
    style.textContent = '.settings > nav { display: none !important; } .settings > section { flex: 0 0 390px !important; max-width: 390px; }';
    document.head.append(style);
  })()`);
  const fits = `(() => { const el = document.querySelector('${id('plugins-page')}'); return el.getBoundingClientRect().width === 390 && el.scrollWidth <= el.clientWidth; })()`;
  await page.evaluate(`document.querySelector('${id('plugins-page')}').scrollTop = 0`);
  expect(await page.evaluate(fits)).toBe(true);
  await captureColumn('plugins-390.png');
  await inspect('https://github.com/example/pi-pool');
  await scrollTo(id('plugins-add'));
  expect(await page.evaluate(fits)).toBe(true);
  await captureColumn('plugins-390-preview.png');
  await page.click(id('plugin-dismiss'));
  await page.evaluate(`document.getElementById('plugins-column').remove()`);
}, 30_000);

test('a phone-wide window gets the phone settings, which leave plugins to the desktop', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor(`document.querySelector('${id('mobile-settings-home')}')`);
  expect(await page.evaluate(`document.querySelector('${id('plugins-page')}') === null && document.querySelector('${id('settings-tab-plugins')}') === null`)).toBe(true);
  await capture('plugins-phone-home.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
}, 30_000);
