import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startUi } from './lib/ui';

let server: { close(): Promise<void> };
let page: BrowserPage;
let base: string;
const id = (name: string) => `[data-testid="${name}"]`;
const card = `${id('machine-card')}[data-machine-id="http://builder.test"]`;
const captureDir = process.env.BOITE_SERVER_UPDATE_CAPTURES ?? join(import.meta.dir, '.artifacts');

beforeAll(async () => { const port = await freePort(); base = `http://127.0.0.1:${port}`; server = await startUi(port); }, 90_000);
beforeEach(async () => { page = await BrowserPage.launch({ url: `${base}/?fake=1&machines=1&open=recent` }); }, 30_000);
afterEach(async () => { await page?.close(); }, 15_000);
afterAll(async () => { await server?.close(); }, 15_000);

async function size(width: number) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 720 });
}
async function machines() {
  await page.waitFor(`window.__boiteTest?.workspace.machines.length === 2`);
  // Settings is also reached through the visible menu below; this opens its page after a reload.
  await page.evaluate(`window.__boiteTest.workspace.active.showSettings('machines')`);
  await page.waitFor(`document.querySelector('${card} ${id('server-update-card')}')`);
}
async function capture(name: string) {
  await page.evaluate('document.fonts.ready');
  await page.evaluate('Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.screenshot(join(captureDir, `server-update-${name}.png`));
}

test('current servers hide update actions and available updates open their owning machine', async () => {
  await size(1400);
  await machines();
  await page.waitFor(`document.querySelector('${card} ${id('server-update-check')}')`);
  expect(await page.evaluate(`document.querySelector('${id('nav-app-update')}') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${card} ${id('server-update-install')}') === null`)).toBe(true);
  await capture('current-desktop');
  await page.navigate(`${base}/?fake=1&machines=1&open=recent&serverUpdate=available`);
  await page.waitFor(`document.querySelector('${id('nav-app-update')}')`);
  await page.click(id('nav-app-update'));
  await page.waitFor(`document.querySelector('${id('nav-server-update')}')`);
  await page.evaluate(`Array.from(document.querySelectorAll('${id('nav-server-update')}')).find(button => button.textContent.includes('Builder')).click()`);
  await page.waitFor(`window.__boiteTest.workspace.active.machineId === 'http://builder.test' && document.querySelector('${card} ${id('server-update-install')}')`);
  await capture('available-desktop');
  await page.click(`${card} ${id('server-update-install')}`);
  await page.waitFor(`document.querySelector('${id('confirm-ok')}')`);
  expect(await page.text(id('confirm-dialog'))).toContain('Builder');
  await capture('confirm-desktop');
  await page.click(id('confirm-ok'));
  await page.waitFor(`document.querySelector('${card} ${id('server-update-status')}')?.textContent.includes('Waiting')`);
  await capture('waiting-desktop');
  await page.click(`${card} ${id('server-update-cancel')}`);
  await page.waitFor(`document.querySelector('${card} ${id('server-update-install')}')`);
  // Other machines keep their own offer and cannot inherit Builder's install or cancel.
  expect(await page.evaluate(`window.__boiteTest.workspace.machines.find(machine => machine.id !== 'http://builder.test').store.serverUpdater.snapshot.phase`)).toBe('available');
}, 45_000);

test('the phone can update and cancel its server without overflowing the screen', async () => {
  await size(390);
  await page.navigate(`${base}/?fake=1&machines=1&open=recent&serverUpdate=available`);
  await machines();
  await capture('available-phone');
  await page.click(`${card} ${id('server-update-install')}`);
  await page.waitFor(`document.querySelector('${id('confirm-ok')}')`);
  await capture('confirm-phone');
  await page.click(id('confirm-ok'));
  await page.waitFor(`document.querySelector('${card} ${id('server-update-status')}')?.textContent.includes('Waiting')`);
  await capture('waiting-phone');
  await page.click(`${card} ${id('server-update-cancel')}`);
  await page.waitFor(`document.querySelector('${card} ${id('server-update-install')}')`);
}, 45_000);
