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
  if (await page.evaluate(`document.querySelector('${id('error-toast')} .dismiss') !== null`)) {
    await page.click(`${id('error-toast')} .dismiss`);
    await page.waitFor(`document.querySelector('${id('error-toast')}') === null`);
  }
  await page.evaluate('document.fonts.ready');
  await page.evaluate('Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))');
  await page.screenshot(join(import.meta.dir, '.artifacts', `app-update-${name}.png`));
}
async function updates(phase: string, nightly = false) {
  await page.navigate(`${base}/?fake=1&appUpdate=${phase}${nightly ? '&appUpdateChannel=nightly&appUpdateCurrentChannel=nightly' : ''}`);
  await page.waitFor(`document.querySelector('${id('nav-app-update')}')`);
  await openUpdate();
}
async function openUpdate() {
  if (await page.evaluate('innerWidth <= 720')) {
    // Native updates live in the shell drawer. The browser fixture uses phone
    // navigation, so expose that same drawer before exercising its real control.
    if (await page.evaluate("document.querySelector('.body.mobile-covered') !== null")) {
      await page.click(id('mobile-new'));
      await page.waitFor("document.querySelector('.body.mobile-covered') === null");
    }
    await page.evaluate('window.__boiteTest.workspace.active.sidebarOpen = true');
  }
  await page.waitFor(`(() => {
    const button = document.querySelector('${id('nav-app-update')}');
    if (!button) return false;
    const box = button.getBoundingClientRect();
    return getComputedStyle(button).visibility === 'visible' && box.width > 0 && box.height > 0
      && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
  })()`);
  await page.click(id('nav-app-update'));
  await page.waitFor(`document.querySelector('${id('app-update-popover')}')`);
}
async function escapeUpdate() {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.waitFor(`document.querySelector('${id('app-update-popover')}') === null`);
}
async function pickDesktopLocale(locale: 'en' | 'fr') {
  await page.click(id('nav-settings'));
  await page.waitFor(`document.querySelector('${id('settings-tab-appearance')}')`);
  await page.click(id('settings-tab-appearance'));
  await page.waitFor(`document.querySelector('${id(`locale-${locale}`)}')`);
  await page.click(id(`locale-${locale}`));
  await page.waitFor(`document.documentElement.lang === '${locale}'`);
  await page.click(id('settings-back'));
  await page.waitFor(`document.querySelector('${id('nav-app-update')}')`);
}

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = await startUi(port);
}, 60_000);

beforeEach(async () => {
  page = await BrowserPage.launch({ url: `${base}/?fake=1` });
  await width(1400);
}, 30_000);
afterEach(async () => { await page?.close(); }, 15_000);
afterAll(async () => { await server?.close(); }, 15_000);

test('footer icons open a compact update popup with release details and an external changelog', async () => {
  await page.navigate(`${base}/?fake=1&open=recent&machines=1&appUpdate=ready&appUpdateChannel=nightly`);
  await page.waitFor(`document.querySelector('${id('nav-settings')}')`);
  await page.waitFor(`document.querySelector('${id('nav-app-update')}')`);
  expect(await page.evaluate(`document.querySelector('.foot ${id('nav-app-update')}') !== null`)).toBe(true);
  expect((await page.text(id('add-project'))).trim()).toBe('');
  expect((await page.text(id('panel-toggle'))).trim()).toBe('');
  await page.click(id('nav-app-update'));
  await page.waitFor(`document.querySelector('${id('app-update-popover')}')`);
  expect(await page.text(id('app-update-popover'))).toContain('Boite Nightly 2.0.0-nightly.8');
  expect(await page.text(id('app-update-published'))).toMatch(/Released .*ago/);
  expect(await page.evaluate(`document.querySelector('${id('app-update-changelog')}').href`)).toBe('https://github.com/beboite/boite/releases/tag/v2.0.0-nightly.8');
  expect(await page.evaluate(`document.querySelector('${id('settings-page')}') === null`)).toBe(true);
  await page.evaluate('window.__openedRelease = null; window.open = (url) => { window.__openedRelease = url; return null; }');
  await page.click(id('app-update-changelog'));
  expect(await page.evaluate('window.__openedRelease')).toBe('https://github.com/beboite/boite/releases/tag/v2.0.0-nightly.8');
  await capture('release-desktop');
  await escapeUpdate();
  await page.evaluate('window.__boiteTest.workspace.active.setSidebarWidth(208)');
  await page.click(id('machine-status'));
  await page.waitFor(`document.querySelector('${id('machine-status-menu')} [data-value]')`);
  await page.evaluate(`document.querySelectorAll('${id('machine-status-menu')} [data-value]')[2].click()`);
  await page.waitFor(`document.querySelector('${id('machine-status-menu')}') === null`);
  expect(await page.evaluate(`(() => {
    const controls = ['machine-status', 'add-project', 'nav-app-update', 'nav-limits', 'nav-settings'].map(name => document.querySelector('[data-testid="' + name + '"]').getBoundingClientRect());
    const foot = document.querySelector('.foot').getBoundingClientRect();
    return controls.every((box, index) => box.width >= 26 && box.right <= foot.right && (!index || box.left >= controls[index - 1].right));
  })()`)).toBe(true);
  await capture('narrow-sidebar');

}, 30_000);

test('the update popup closes outside and by keyboard, and confirms installation in both languages', async () => {
  await updates('ready', true);
  await width(880);
  await escapeUpdate();
  expect(await page.evaluate(`document.activeElement === document.querySelector('${id('nav-app-update')}')`)).toBe(true);
  await openUpdate();
  await page.evaluate(`document.querySelector('${id('titlebar')}').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await page.waitFor(`document.querySelector('${id('app-update-popover')}') === null`);
  for (const locale of ['en', 'fr'] as const) {
    await pickDesktopLocale(locale);
    await capture(`footer-${locale}`);
    await openUpdate();
    expect(await page.evaluate('document.documentElement.scrollWidth <= 880')).toBe(true);
    await capture(`popup-${locale}`);
    await page.click(id('app-update-install'));
    await page.waitFor(`document.querySelector('${id('confirm-cancel')}') && !document.querySelector('${id('app-update-popover')}')`);
    await capture(`confirmation-${locale}`);
    await page.click(id('confirm-cancel'));
    await page.waitFor(`document.querySelector('${id('confirm-cancel')}') === null`);
  }
  await openUpdate();
  await page.click(id('app-update-install'));
  await page.waitFor(`document.querySelector('${id('confirm-ok')}')`);
  await page.click(id('confirm-ok'));
  await page.waitFor(`document.querySelector('${id('confirm-ok')}') === null`);
  await openUpdate();
  await page.waitFor(`document.querySelector('${id('app-update-install')}') === null`);
  expect(await page.text(id('app-update-status'))).toContain("Démarrage");
}, 30_000);

test('hiding the reminder persists without losing the update button or installation', async () => {
  await updates('ready');
  expect(await page.evaluate(`document.querySelector('${id('app-update-badge')}') !== null`)).toBe(true);
  await page.click(id('update-notice-dismiss'));
  await page.waitFor(`document.querySelector('${id('app-update-popover')}') === null`);
  await page.reload();
  await page.waitFor(`document.querySelector('${id('nav-app-update')}')`);
  expect(await page.evaluate(`document.querySelector('${id('app-update-badge')}') === null`)).toBe(true);
  await openUpdate();
  expect(await page.evaluate(`document.querySelector('${id('app-update-install')}') !== null`)).toBe(true);
  await escapeUpdate();
  await page.click(id('nav-settings'));
  await page.waitFor(`document.querySelector('${id('settings-tab-general')}')`);
  await page.click(id('settings-tab-general'));
  expect(await page.evaluate(`document.querySelector('${id('app-update-card')}') === null`)).toBe(true);
  await openUpdate();
  expect(await page.evaluate(`document.querySelector('${id('app-update-install')}') !== null`)).toBe(true);
  await updates('ready', true);
  expect(await page.evaluate(`document.querySelector('${id('app-update-badge')}') !== null`)).toBe(true);
}, 30_000);

test('channel options preserve the installed channel and nightly window name', async () => {
  await updates('ready', true);
  await page.waitFor(`document.title.endsWith('boite (de nuit)')`);
  expect(await page.text(id('titlebar'))).not.toContain('boite (de nuit)');
  await page.click(`${id('app-update-popover')} summary`);
  await page.click(id('app-update-stable'));
  await page.waitFor(`document.querySelector('${id('app-update-stable')}').getAttribute('aria-pressed') === 'true'`);
  expect(await page.text(id('app-update-content'))).toContain('Installed version: Boite Nightly');
  await capture('channel-options');
}, 30_000);

test('download progress and retry fit a narrow desktop', async () => {
  await updates('downloading');
  expect(await page.evaluate(`document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')`)).toBe('38');
  await capture('downloading-desktop');
  await updates('error');
  await width(880);
  expect(await page.evaluate('document.documentElement.scrollWidth <= 880')).toBe(true);
  await capture('error-narrow');
  await page.click(id('app-update-retry'));
  await page.waitFor(`document.querySelector('${id('app-update-check')}')`);
}, 30_000);

test('checking stays disabled and the popup fits a narrow desktop', async () => {
  await updates('checking', true);
  await page.waitFor(`document.querySelector('${id('app-update-check')}')?.disabled === true`);
  expect(await page.evaluate(`document.querySelector('${id('app-update-check')}').getAttribute('aria-busy')`)).toBe('true');
  await capture('checking-desktop');
  await escapeUpdate();
  await width(880);
  await openUpdate();
  expect(await page.evaluate(`(() => { const r = document.querySelector('${id('app-update-popover')}').getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`)).toBe(true);
  await capture('checking-narrow');
}, 30_000);

test('ordinary browsers never offer native updates, including French phone settings', async () => {
  await page.navigate(`${base}/?fake=1`);
  await width(390);
  await page.waitFor(`document.querySelector('${id('nav-settings')}')`);
  await page.click(id('nav-settings'));
  await page.waitFor(`document.querySelector('${id('mobile-settings-home')}')`);
  expect(await page.evaluate(`document.querySelector('${id('nav-app-update')}') === null`)).toBe(true);
  expect(await page.evaluate('document.documentElement.scrollWidth <= 390')).toBe(true);
  await capture('phone');
  await page.click(id('settings-tab-appearance'));
  await page.waitFor(`document.querySelector('${id('locale-fr')}')`);
  await page.click(id('locale-fr'));
  await page.waitFor(`document.documentElement.lang === 'fr'`);
  await page.reload();
  await page.waitFor(`document.documentElement.lang === 'fr' && document.querySelector('${id('nav-settings')}')`);
  await page.click(id('nav-settings'));
  await page.waitFor(`document.querySelector('${id('mobile-settings-home')}')`);
  expect(await page.evaluate(`document.querySelector('${id('nav-app-update')}') === null`)).toBe(true);
  await capture('phone-fr');
}, 30_000);

test('waiting can be dismissed and cancellation restores the downloaded update on desktop and phone', async () => {
  for (const viewport of [1400, 390]) {
    await width(viewport);
    await updates('waiting');
    expect(await page.text(id('app-update-status'))).toContain('Waiting for work');
    expect(await page.evaluate(`document.querySelector('${id('app-update-check')}') === null`)).toBe(true);
    await page.click(`${id('app-update-popover')} summary`);
    expect(await page.evaluate(`document.querySelector('${id('app-update-nightly')}').disabled`)).toBe(true);
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await page.waitFor(`(() => {
      const popup = document.querySelector('${id('app-update-popover')}');
      if (!popup) return false;
      const box = popup.getBoundingClientRect();
      const style = getComputedStyle(popup);
      return style.visibility === 'visible' && Number(style.opacity) === 1
        && box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0
        && box.right <= innerWidth && box.bottom <= innerHeight
        && popup.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
    })()`);
    await capture(`waiting-${viewport < 720 ? 'phone' : 'desktop'}`);
    await escapeUpdate();
    await openUpdate();
    await page.click(id('app-update-cancel'));
    await page.waitFor(`document.querySelector('${id('app-update-install')}') !== null`);
    expect(await page.text(id('app-update-content'))).toContain('2.0.0-beta.2');
    await page.click(`${id('app-update-popover')} summary`);
    expect(await page.evaluate(`document.querySelector('${id('app-update-nightly')}').disabled`)).toBe(false);
  }
}, 30_000);
