import { mobileAction } from './lib/mobile.ts';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
let base: string;
const id = (name: string) => `[data-testid="${name}"]`;
const width = (value: number) => page.send('Emulation.setDeviceMetricsOverride', { width: value, height: 1000, deviceScaleFactor: 1, mobile: value < 720 });
async function capture(name: string) {
  await page.evaluate('document.fonts.ready');
  await page.evaluate('Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.screenshot(join(process.env.BOITE_UPDATE_CAPTURES ?? join(import.meta.dir, '.artifacts'), `app-update-${name}.png`));
}
async function machines() {
  if (await page.evaluate('innerWidth <= 720')) {
    await mobileAction(page, 'mobile-settings');
  } else {
    await page.click(id('nav-settings'));
  }
  await page.waitFor(`document.querySelector('${id('settings-tab-machines')}')`);
  await page.click(id('settings-tab-machines'));
  await page.waitFor(`document.querySelector('${id('machines-page')}')`);
}
async function updates(phase: string, nightly = false) {
  await page.navigate(`${base}/?fake=1&appUpdate=${phase}${nightly ? '&appUpdateChannel=nightly&appUpdateCurrentChannel=nightly' : ''}`);
  await page.waitFor(`document.querySelector('${id('nav-settings')}')`);
  await machines();
  await page.waitFor(`document.querySelector('${id('app-update-card')}')`);
}
async function pickLocale(locale: 'en' | 'fr') {
  await page.click(id('settings-tab-appearance'));
  await page.waitFor(`document.querySelector('${id(`locale-${locale}`)}')`);
  await page.click(id(`locale-${locale}`));
  await page.waitFor(`document.documentElement.lang === '${locale}'`);
  await page.click(id('settings-tab-machines'));
  await page.waitFor(`document.querySelector('${id('app-update-card')}')`);
}

beforeAll(async () => { const port = await freePort(); base = `http://127.0.0.1:${port}`; server = await startUi(port); }, 60_000);
beforeEach(async () => { page = await BrowserPage.launch({ url: `${base}/?fake=1` }); await width(1400); }, 30_000);
afterEach(async () => { await page?.close(); }, 15_000);
afterAll(async () => { await server?.close(); }, 15_000);

test('updates are reached through Machines without adding a footer shortcut', async () => {
  await page.navigate(`${base}/?fake=1&open=recent&machines=1&appUpdate=ready&appUpdateChannel=nightly`);
  await page.waitFor(`window.__boiteTest?.workspace.machines.length === 2 && ['machine-status', 'add-project', 'nav-limits', 'nav-settings'].every(name => document.querySelector('[data-testid="' + name + '"]'))`);
  expect(await page.evaluate(`document.querySelector('${id('nav-app-update')}') === null`)).toBe(true);
  expect((await page.text(id('add-project'))).trim()).toBe('');
  expect((await page.text(id('panel-toggle'))).trim()).toBe('');
  await page.evaluate('window.__boiteTest.workspace.active.setSidebarWidth(208)');
  expect(await page.evaluate(`(() => {
    const controls = ['machine-status', 'add-project', 'nav-limits', 'nav-settings'].map(name => document.querySelector('[data-testid="' + name + '"]').getBoundingClientRect());
    const foot = document.querySelector('.foot').getBoundingClientRect();
    return controls.every((box, index) => box.width >= 26 && box.right <= foot.right && (!index || box.left >= controls[index - 1].right));
  })()`)).toBe(true);
  const active = await page.evaluate('window.__boiteTest.workspace.active.machineId');
  await page.evaluate(`document.querySelector('${id('nav-settings')}').focus()`);
  expect(await page.evaluate(`document.activeElement === document.querySelector('${id('nav-settings')}')`)).toBe(true);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.waitFor(`document.querySelector('${id('settings-tab-machines')}')`);
  await page.click(id('settings-tab-machines'));
  await page.waitFor(`document.querySelector('${id('machines-page')}')`);
  expect(await page.evaluate('window.__boiteTest.workspace.active.machineId')).toBe(active);
  expect(await page.evaluate(`document.querySelector('${id('nav-app-update')}') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('app-update-popover')}') === null`)).toBe(true);
  expect(await page.text(id('app-update-card'))).toContain('Boite Nightly 2.0.0-nightly.8');
  expect(await page.text(id('app-update-published'))).toMatch(/Released .*ago/);
  expect(await page.evaluate(`document.querySelector('${id('app-update-changelog')}').href`)).toBe('https://github.com/beboite/boite/releases/tag/v2.0.0-nightly.8');
  await page.evaluate('window.__openedRelease = null; window.open = (url) => { window.__openedRelease = url; return null; }');
  await page.click(id('app-update-changelog'));
  expect(await page.evaluate('window.__openedRelease')).toBe('https://github.com/beboite/boite/releases/tag/v2.0.0-nightly.8');
  await capture('release-desktop');
}, 30_000);

test('installation confirms in both languages and cancelling keeps the downloaded update available', async () => {
  await updates('ready', true);
  await width(880);
  for (const locale of ['en', 'fr'] as const) {
    await pickLocale(locale);
    await capture(`machines-${locale}`);
    await page.click(id('app-update-install'));
    await page.waitFor(`document.querySelector('${id('confirm-cancel')}')`);
    await capture(`confirmation-${locale}`);
    await page.click(id('confirm-cancel'));
    await page.waitFor(`document.querySelector('${id('confirm-cancel')}') === null`);
    expect(await page.evaluate(`document.querySelector('${id('app-update-install')}') !== null`)).toBe(true);
  }
  await page.click(id('app-update-install'));
  await page.waitFor(`document.querySelector('${id('confirm-ok')}')`);
  await page.click(id('confirm-ok'));
  await page.waitFor(`document.querySelector('${id('app-update-install')}') === null`);
  expect(await page.text(id('app-update-status'))).toContain("l'installation démarre");
}, 30_000);

test('General has no update controls or shortcut and the Machines tab opens updates', async () => {
  await updates('ready');
  await page.click(id('settings-tab-general'));
  await page.waitFor(`document.querySelector('${id('settings-page')}')`);
  expect(await page.evaluate(`document.querySelector('${id('app-update-card')}') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('app-update-install')}') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('nav-app-update')}') === null`)).toBe(true);
  await page.click(id('settings-tab-machines'));
  await page.waitFor(`document.querySelector('${id('machines-page')}') && document.querySelector('${id('app-update-install')}')`);
  expect(await page.evaluate(`document.querySelector('${id('app-update-popover')}') === null`)).toBe(true);
}, 30_000);

test('channel options preserve the installed channel and nightly window name', async () => {
  await updates('ready', true);
  await page.waitFor(`document.title.endsWith('boite (de nuit)')`);
  expect(await page.text(id('titlebar'))).not.toContain('boite (de nuit)');
  await page.click(`${id('app-update-card')} summary`);
  await page.click(id('app-update-stable'));
  await page.waitFor(`document.querySelector('${id('app-update-stable')}').getAttribute('aria-pressed') === 'true'`);
  expect(await page.text(id('app-update-content'))).toContain('Installed version: Boite Nightly');
  await capture('channel-options');
}, 30_000);

test('download progress and retry fit a narrow desktop', async () => {
  await updates('downloading');
  expect(await page.evaluate(`document.querySelector('${id('app-update-card')} [role="progressbar"]').getAttribute('aria-valuenow')`)).toBe('38');
  await capture('downloading-desktop');
  await updates('error');
  await width(880);
  await capture('error-narrow');
  await page.click(id('app-update-retry'));
  await page.waitFor(`document.querySelector('${id('app-update-status')}')?.textContent.includes('Boite is up to date')`);
  expect(await page.evaluate(`document.querySelector('${id('app-update-check')}').disabled`)).toBe(false);
}, 30_000);

test('a running check remains visible and disabled in Machines', async () => {
  await updates('checking', true);
  expect(await page.evaluate(`document.querySelector('${id('nav-app-update')}') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('app-update-check')}').disabled`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('app-update-check')}').getAttribute('aria-busy')`)).toBe('true');
  await capture('checking-desktop');
  await width(880); await capture('checking-narrow');
}, 30_000);

test('ordinary browsers have no native update controls in Machines, including French phone settings', async () => {
  await width(390);
  await page.navigate(`${base}/?fake=1`);
  await page.waitFor(`document.querySelector('${id('nav-settings')}')`);
  await machines();
  expect(await page.evaluate(`document.querySelector('${id('app-update-card')}') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('app-update-install')}') === null`)).toBe(true);
  await capture('phone');
  await page.evaluate(`localStorage.setItem('boite.locale', 'fr')`);
  await page.reload();
  await page.waitFor(`document.documentElement.lang === 'fr' && document.querySelector('${id('nav-settings')}')`);
  await machines();
  expect(await page.evaluate(`document.querySelector('${id('app-update-card')}') === null`)).toBe(true);
  await capture('phone-fr');
  expect((await page.text('.mobile-settings > header h1')).trim()).toBe('Machines et mises à jour');
}, 30_000);

test('waiting keeps channel changes disabled and cancellation restores the download at desktop and phone widths', async () => {
  for (const viewport of [1400, 390]) {
    await width(viewport);
    await updates('waiting');
    expect(await page.text(id('app-update-status'))).toContain('Waiting for work');
    expect(await page.evaluate(`document.querySelector('${id('app-update-check')}') === null`)).toBe(true);
    await page.click(`${id('app-update-card')} summary`);
    expect(await page.evaluate(`document.querySelector('${id('app-update-nightly')}').disabled`)).toBe(true);
    await capture(`waiting-${viewport < 720 ? 'phone' : 'desktop'}`);
    await page.click(id('app-update-cancel'));
    await page.waitFor(`document.querySelector('${id('app-update-install')}') !== null`);
    expect(await page.text(id('app-update-content'))).toContain('2.0.0-beta.2');
    expect(await page.evaluate(`document.querySelector('${id('app-update-nightly')}').disabled`)).toBe(false);
  }
}, 30_000);
