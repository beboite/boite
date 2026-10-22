import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startUi } from './lib/ui';

let server: { close(): Promise<void> };
let page: BrowserPage;
let base: string;
const id = (name: string) => `[data-testid="${name}"]`;
// Builder's row in the machine list, and its Boite release in the updates card above it.
const row = `${id('machine-card')}[data-machine-id="http://builder.test"]`;
const builderLabel = 'Builder';
const part = `${id('updates-other')}[data-part="boite"]`;
const captureDir = process.env.BOITE_SERVER_UPDATE_CAPTURES ?? join(import.meta.dir, '.artifacts');

beforeAll(async () => { const port = await freePort(); base = `http://127.0.0.1:${port}`; server = await startUi(port); }, 90_000);
beforeEach(async () => { page = await BrowserPage.launch({ url: `${base}/?fake=1&machines=1&open=recent` }); }, 30_000);
afterEach(async () => { await page?.close(); }, 15_000);
afterAll(async () => { await server?.close(); }, 30_000);

async function size(width: number) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 720 });
}
async function machines() {
  await page.waitFor(`window.__boiteTest?.workspace.machines.length === 2`);
  // Settings is also reached through the visible menu below; this opens its page after a reload.
  await page.evaluate(`window.__boiteTest.workspace.active.showSettings('machines')`);
  await page.waitFor(`document.querySelector('${id('app-updates-card')}') && document.querySelector('${row} ${id('machine-updates-state')}')`);
}
async function capture(name: string) {
  await page.evaluate('document.fonts.ready');
  await page.evaluate('Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.screenshot(join(captureDir, `server-update-${name}.png`));
}
const state = () => page.evaluate<string>(`document.querySelector('${row} ${id('machine-updates-state')}')?.dataset.state ?? ''`);
const builderPart = () => page.evaluate<string>(`[...document.querySelectorAll('${part}')].find(item => item.textContent.includes('${builderLabel}'))?.textContent ?? ''`);
/** Update starts every pending part at once, with no confirmation, and Builder's server can be stopped while it downloads or waits. */
async function updateAndCancel(prefix: string) {
  expect(await page.evaluate(`document.querySelector('${id('updates-run-all')}').disabled`)).toBe(false);
  await page.click(id('updates-run-all'));
  await page.waitFor(`document.querySelector('${id('server-update-cancel')}') && !document.querySelector('${id('server-update-cancel')}').disabled`);
  expect(await page.evaluate(`document.querySelector('${id('confirm-dialog')}') === null`)).toBe(true);
  expect(await page.evaluate(`window.__boiteTest.workspace.machines.find(machine => machine.id === 'http://builder.test').store.serverUpdater.snapshot.phase`)).toMatch(/^(downloading|waiting)$/);
  await capture(`running-${prefix}`);
  await page.click(id('server-update-cancel'));
  await page.waitFor(`window.__boiteTest.workspace.machines.find(machine => machine.id === 'http://builder.test').store.serverUpdater.snapshot.phase === 'available'`);
  await page.waitFor(`document.querySelector('${id('server-update-cancel')}') === null`);
  expect(await builderPart()).toContain('2.0.0-beta.2');
}

test('a server release shows in the footer and in Machines, and actions target their owning machine', async () => {
  await size(1400);
  await machines();
  // Up to date: the row says so, and nothing of Builder waits in the card.
  await page.waitFor(`document.querySelector('${row} ${id('machine-updates-state')}')?.dataset.state === 'current'`);
  expect(await page.evaluate(`document.querySelector('${id('nav-updates')}') === null`)).toBe(true);
  expect(await builderPart()).toBe('');
  expect(await page.text(`${row} ${id('machine-version')}`)).toBe('2.0.0-beta.1');
  await capture('current-desktop');
  await page.navigate(`${base}/?fake=1&machines=1&open=recent&serverUpdate=available`);
  await page.waitFor(`document.querySelector('${id('nav-settings')}') && window.__boiteTest?.workspace.machines.length === 2`);
  await page.waitFor(`document.querySelector('${id('nav-updates')}')`);
  const active = await page.evaluate('window.__boiteTest.workspace.active.machineId');
  await page.click(id('nav-settings'));
  await page.waitFor(`document.querySelector('${id('settings-tab-machines')}')`);
  await page.click(id('settings-tab-machines'));
  await page.waitFor(`document.querySelector('${row} ${id('machine-updates-state')}')?.dataset.state === 'available'`);
  await page.waitFor(`[...document.querySelectorAll('${part}')].some(item => item.textContent.includes('${builderLabel}'))`);
  expect(await page.evaluate('window.__boiteTest.workspace.active.machineId')).toBe(active);
  const offer = await builderPart();
  expect(offer).toContain('2.0.0-beta.1');
  expect(offer).toContain('2.0.0-beta.2');
  await capture('available-desktop');
  await updateAndCancel('desktop');
  expect(await state()).toBe('available');
  // Other machines keep their own offer and cannot inherit Builder's install or cancel.
  expect(await page.evaluate(`window.__boiteTest.workspace.machines.find(machine => machine.id !== 'http://builder.test').store.serverUpdater.snapshot.phase`)).toBe('available');
}, 45_000);

test('the phone can update and cancel its server without overflowing the screen', async () => {
  await size(390);
  await page.navigate(`${base}/?fake=1&machines=1&open=recent&serverUpdate=available`);
  await machines();
  await page.waitFor(`[...document.querySelectorAll('${part}')].some(item => item.textContent.includes('${builderLabel}'))`);
  await capture('available-phone');
  await page.click(id('updates-run-all'));
  await page.waitFor(`document.querySelector('${id('server-update-cancel')}') && !document.querySelector('${id('server-update-cancel')}').disabled`);
  // The cancel stays on screen beside Builder's row.
  expect(await page.evaluate(`document.querySelector('${id('server-update-cancel')}').getBoundingClientRect().right <= innerWidth`)).toBe(true);
  await capture('running-phone');
  await page.click(id('server-update-cancel'));
  await page.waitFor(`window.__boiteTest.workspace.machines.find(machine => machine.id === 'http://builder.test').store.serverUpdater.snapshot.phase === 'available'`);
  await page.waitFor(`document.querySelector('${id('server-update-cancel')}') === null`);
  expect(await builderPart()).toContain('2.0.0-beta.2');
}, 45_000);
