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
  // A phone's settings open on the machine itself, which leads to Machines.
  const phone = await page.evaluate<boolean>('innerWidth <= 720');
  if (phone) await mobileAction(page, 'mobile-settings');
  else await page.click(id('nav-settings'));
  const entry = phone ? 'mobile-settings-connection' : 'settings-tab-machines';
  await page.waitFor(`document.querySelector('${id(entry)}')`);
  await page.click(id(entry));
  await page.waitFor(`document.querySelector('${id('machines-page')}')`);
}
async function updates(phase: string, nightly = false) {
  await page.navigate(`${base}/?fake=1&appUpdate=${phase}${nightly ? '&appUpdateChannel=nightly&appUpdateCurrentChannel=nightly' : ''}`);
  await page.waitFor(`document.querySelector('${id('nav-settings')}')`);
  await machines();
  await page.waitFor(`document.querySelector('${id('app-updates-card')}')`);
}
async function pickLocale(locale: 'en' | 'fr') {
  await page.click(id('settings-tab-appearance'));
  await page.waitFor(`document.querySelector('${id(`locale-${locale}`)}')`);
  await page.click(id(`locale-${locale}`));
  await page.waitFor(`document.documentElement.lang === '${locale}'`);
  await page.click(id('settings-tab-machines'));
  await page.waitFor(`document.querySelector('${id('app-updates-card')}')`);
}
const disabled = (name: string) => page.evaluate<boolean>(`document.querySelector('${id(name)}').disabled`);
const absent = (name: string) => page.evaluate<boolean>(`document.querySelector('${id(name)}') === null`);

beforeAll(async () => { const port = await freePort(); base = `http://127.0.0.1:${port}`; server = await startUi(port); }, 60_000);
beforeEach(async () => { page = await BrowserPage.launch({ url: `${base}/?fake=1` }); await width(1400); }, 30_000);
afterEach(async () => { await page?.close(); }, 15_000);
afterAll(async () => { await server?.close(); }, 30_000);

test('the footer button and Machines both reach updates, and the foot fits its controls', async () => {
  await page.navigate(`${base}/?fake=1&open=recent&machines=1&appUpdate=ready&appUpdateChannel=nightly`);
  await page.waitFor(`window.__boiteTest?.workspace.machines.length === 2 && ['machine-status', 'add-project', 'nav-updates', 'nav-limits', 'nav-settings'].every(name => document.querySelector('[data-testid="' + name + '"]'))`);
  // A downloaded release is announced in the foot, bottom left, beside Settings.
  expect(await page.evaluate(`document.querySelector('${id('nav-updates')}') !== null`)).toBe(true);
  expect((await page.text(id('add-project'))).trim()).toBe('');
  expect((await page.text(id('panel-toggle'))).trim()).toBe('');
  await page.evaluate('window.__boiteTest.workspace.active.setSidebarWidth(208)');
  expect(await page.evaluate(`(() => {
    const controls = ['machine-status', 'add-project', 'nav-updates', 'nav-limits', 'nav-settings'].map(name => document.querySelector('[data-testid="' + name + '"]').getBoundingClientRect());
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
  await page.waitFor(`document.querySelector('${id('machines-page')}') && document.querySelector('${id('app-updates-card')}')`);
  expect(await page.evaluate('window.__boiteTest.workspace.active.machineId')).toBe(active);
  // The card opens on the installed version and the release found, nothing folded.
  expect(await page.text(id('updates-version'))).toContain('Boite');
  expect(await page.text(id('updates-version'))).toContain('2.0.0-beta.1');
  expect((await page.text(id('updates-found'))).trim()).toBe('2.0.0-nightly.8');
  expect(await page.text(id('app-update-status'))).toContain('Restart to finish');
  expect(await page.evaluate(`document.querySelector('${id('app-update-changelog')}').href`)).toBe('https://github.com/beboite/boite/releases/tag/v2.0.0-nightly.8');
  await page.evaluate('window.__openedRelease = null; window.open = (url) => { window.__openedRelease = url; return null; }');
  await page.click(id('app-update-changelog'));
  expect(await page.evaluate('window.__openedRelease')).toBe('https://github.com/beboite/boite/releases/tag/v2.0.0-nightly.8');
  await capture('release-desktop');
}, 30_000);

test('installation confirms in both languages and cancelling keeps the downloaded update available', async () => {
  await updates('ready', true);
  await width(880);
  // A downloaded release with nothing else waiting: the one button restarts into it.
  expect((await page.text(id('updates-run-all'))).trim()).toBe('Restart');
  for (const locale of ['en', 'fr'] as const) {
    await pickLocale(locale);
    await capture(`machines-${locale}`);
    await page.click(id('updates-run-all'));
    await page.waitFor(`document.querySelector('${id('confirm-cancel')}')`);
    expect(await page.text(id('confirm-dialog'))).toContain(locale === 'en' ? 'Install the Boite update?' : 'Installer la mise à jour de Boite ?');
    await capture(`confirmation-${locale}`);
    await page.click(id('confirm-cancel'));
    await page.waitFor(`document.querySelector('${id('confirm-cancel')}') === null`);
    expect(await disabled('updates-run-all')).toBe(false);
    expect(await page.text(id('app-update-status'))).toContain(locale === 'en' ? 'Restart to finish' : 'Redémarre pour finir');
  }
  expect((await page.text(id('updates-run-all'))).trim()).toBe('Redémarrer');
  await page.click(id('updates-run-all'));
  await page.waitFor(`document.querySelector('${id('confirm-ok')}')`);
  await page.click(id('confirm-ok'));
  await page.waitFor(`document.querySelector('${id('app-update-status')}')?.textContent.includes("l'installation démarre")`);
  expect(await disabled('updates-run-all')).toBe(true);
}, 30_000);

test('General has no update controls or shortcut and the Machines tab opens updates', async () => {
  await updates('ready');
  await page.click(id('settings-tab-general'));
  await page.waitFor(`document.querySelector('${id('settings-page')}')`);
  for (const name of ['app-updates-card', 'updates-run-all', 'updates-check-all', 'app-update-status']) expect(await absent(name)).toBe(true);
  await page.click(id('settings-tab-machines'));
  await page.waitFor(`document.querySelector('${id('machines-page')}') && document.querySelector('${id('app-updates-card')} ${id('updates-run-all')}')`);
  expect(await disabled('updates-run-all')).toBe(false);
}, 30_000);

test('channel options preserve the installed channel and nightly window name, and Release waits for its first build', async () => {
  await updates('ready', true);
  await page.waitFor(`document.title.endsWith('boite (de nuit)')`);
  expect(await page.text(id('titlebar'))).not.toContain('boite (de nuit)');
  // The channel is two buttons in the card, no fold: Nightly is on, Release has nothing published yet.
  expect(await page.evaluate(`document.querySelector('${id('app-updates-card')} details, ${id('app-updates-card')} summary') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('app-update-nightly')}').getAttribute('aria-pressed')`)).toBe('true');
  expect(await disabled('app-update-nightly')).toBe(false);
  expect(await disabled('app-update-stable')).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('app-update-stable')}').title`)).toBe('No release yet: Boite ships nightly builds for now.');
  await page.click(id('app-update-stable'));
  expect(await page.evaluate(`document.querySelector('${id('app-update-stable')}').getAttribute('aria-pressed')`)).toBe('false');
  expect(await page.text(id('updates-version'))).toContain('2.0.0-nightly.7');
  expect((await page.text(id('updates-found'))).trim()).toBe('2.0.0-nightly.8');
  await capture('channel-options');
}, 30_000);

test('download progress and retry fit a narrow desktop', async () => {
  await updates('downloading');
  expect(await page.evaluate(`document.querySelector('${id('app-updates-card')} [role="progressbar"]').getAttribute('aria-valuenow')`)).toBe('38');
  expect(await page.text(id('app-update-status'))).toContain('Downloading');
  expect(await disabled('updates-run-all')).toBe(true);
  await capture('downloading-desktop');
  await updates('error');
  await width(880);
  expect(await page.text(id('app-update-status'))).toContain('The release server did not answer.');
  // A failed download is offered again by the same button, and a fresh check clears the error.
  expect(await disabled('updates-run-all')).toBe(false);
  await capture('error-narrow');
  await page.click(id('updates-check-all'));
  await page.waitFor(`document.querySelector('${id('app-update-status')}')?.textContent.includes('Up to date')`);
  await page.waitFor(`!document.querySelector('${id('updates-check-all')}').disabled`);
  expect(await absent('updates-found')).toBe(true);
}, 30_000);

test('a running check remains visible and disabled in Machines', async () => {
  await updates('checking', true);
  expect(await page.text(id('app-update-status'))).toContain('Checking for updates');
  expect(await disabled('updates-check-all')).toBe(true);
  expect((await page.text(id('updates-check-all'))).trim()).toBe('Checking');
  expect(await page.evaluate(`document.querySelector('${id('updates-check-all')}').getAttribute('aria-busy')`)).toBe('true');
  await capture('checking-desktop');
  await width(880); await capture('checking-narrow');
}, 30_000);

test('ordinary browsers have no native update controls in Machines, including French phone settings', async () => {
  await width(390);
  await page.navigate(`${base}/?fake=1`);
  await page.waitFor(`document.querySelector('${id('nav-settings')}')`);
  await machines();
  // A browser has no updater of its own: the card names the machine's Boite, without channels or a cancel.
  await page.waitFor(`document.querySelector('${id('app-updates-card')}')`);
  const core = await page.evaluate<string>('window.__boiteTest.workspace.active.core?.version ?? ""');
  expect(core).not.toBe('');
  expect(await page.text(id('updates-version'))).toContain(core);
  for (const name of ['app-update-nightly', 'app-update-stable', 'app-update-cancel', 'updates-found']) expect(await absent(name)).toBe(true);
  await capture('phone');
  await page.evaluate(`localStorage.setItem('boite.locale', 'fr')`);
  await page.reload();
  await page.waitFor(`document.documentElement.lang === 'fr' && document.querySelector('${id('nav-settings')}')`);
  await machines();
  await page.waitFor(`document.querySelector('${id('app-updates-card')}')`);
  expect(await absent('app-update-nightly')).toBe(true);
  await capture('phone-fr');
  expect((await page.text('[data-testid=mobile-settings-header] h1')).trim()).toBe('Machines et mises à jour');
}, 30_000);

test('waiting keeps channel changes disabled and cancellation restores the download at desktop and phone widths', async () => {
  for (const viewport of [1400, 390]) {
    await width(viewport);
    await updates('waiting');
    expect(await page.text(id('app-update-status'))).toContain('Waiting for work');
    // While it waits, Cancel replaces the update button, and a check does not disturb it.
    expect(await absent('updates-run-all')).toBe(true);
    expect(await disabled('app-update-nightly')).toBe(true);
    await page.click(id('updates-check-all'));
    await page.waitFor(`!document.querySelector('${id('updates-check-all')}').disabled`);
    expect(await page.text(id('app-update-status'))).toContain('Waiting for work');
    await capture(`waiting-${viewport < 720 ? 'phone' : 'desktop'}`);
    await page.click(id('app-update-cancel'));
    await page.waitFor(`document.querySelector('${id('updates-run-all')}') !== null`);
    expect((await page.text(id('updates-found'))).trim()).toBe('2.0.0-beta.2');
    expect(await disabled('updates-run-all')).toBe(false);
    expect(await disabled('app-update-nightly')).toBe(false);
  }
}, 30_000);

test('installing by itself is this computer\'s switch on the updates card, saved on its core, in both languages', async () => {
  await updates('ready', true);
  // The fixture stands in for the desktop app: the core it shows is the one its shell started.
  await page.evaluate('globalThis.__boiteTest.workspace.active.localCore = true');
  await page.waitFor(`document.querySelector('${id('app-update-auto-switch')}')`);
  expect(await page.evaluate<boolean>(`document.querySelector('${id('app-update-auto-switch')}').checked`)).toBe(false);
  expect(await page.text(id('app-update-auto'))).toContain('Install updates by itself when nothing runs');
  await page.click(id('app-update-auto-switch'));
  await page.waitFor('globalThis.__boiteTest.workspace.active.settings?.autoInstallUpdates === true');
  await page.evaluate(`document.querySelector('${id('app-updates-card')}').scrollIntoView({ block: 'start' })`);
  await capture('auto-install-desktop');

  await pickLocale('fr');
  await width(390);
  await page.waitFor(`document.querySelector('${id('app-update-auto')}')?.getBoundingClientRect().width > 0`);
  expect(await page.text(id('app-update-auto'))).toContain('Installer les mises à jour tout seul quand rien ne tourne');
  expect(await page.evaluate<boolean>(`document.querySelector('${id('app-update-auto-switch')}').checked`)).toBe(true);
  await page.evaluate(`document.querySelector('${id('app-updates-card')}').scrollIntoView({ block: 'start' })`);
  await capture('auto-install-phone-fr');
  expect(page.errors()).toEqual([]);
}, 60_000);
