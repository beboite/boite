import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
let url: string;
const id = (name: string) => `[data-testid="${name}"]`;
const local = `${id('machine-updates-card')}:first-child`;
const remote = `${id('machine-updates-card')}[data-machine-id="http://builder.test"]`;
const row = (card: string, provider: string) => `${card} ${id('machine-agent-update')}[data-provider-id="${provider}"]`;
async function capture(name: string) {
  await page.evaluate('document.fonts.ready');
  await page.evaluate('Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.screenshot(join(process.env.BOITE_UPDATE_CAPTURES ?? join(import.meta.dir, '.artifacts'), `${name}.png`));
}
const size = (width: number) => page.send('Emulation.setDeviceMetricsOverride', { width, height: width < 720 ? 844 : 1000, deviceScaleFactor: 1, mobile: width < 720 });
async function machines() {
  await page.click(id('nav-settings'));
  await page.waitFor(`document.querySelector('${id('settings-tab-machines')}')`);
  await page.click(id('settings-tab-machines'));
  await page.waitFor(`document.querySelectorAll('${id('harness-updates-card')}').length === 2`);
}

beforeAll(async () => {
  const port = await freePort(); url = `http://127.0.0.1:${port}/?fake=1&updates=1&machines=1&open=recent`;
  server = await startUi(port);
}, 60_000);
beforeEach(async () => { page = await BrowserPage.launch({ url }); await size(1400); await page.waitFor(`document.querySelector('${id('nav-settings')}') && window.__boiteTest?.workspace.machines.length === 2`); }, 30_000);
afterEach(async () => { await page?.close(); }, 15_000);
afterAll(async () => { await server?.close(); }, 15_000);

test('agent updates stay in Machines and Update and Skip target their own machine on desktop and phone', async () => {
  expect(await page.evaluate(`document.querySelector('${id('harness-update-notices')}') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('nav-app-update')}') === null`)).toBe(true);
  await capture('harness-updates-chat');
  await machines();
  expect((await page.text(id('settings-tab-machines'))).trim()).toBe('Machines and updates');
  expect(await page.evaluate(`document.querySelectorAll('#settings-updates ${id('harness-updates-card')}').length`)).toBe(2);
  expect(await page.evaluate(`document.querySelector('#settings-machines ${id('harness-updates-card')}') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('app-update-popover')}') === null`)).toBe(true);
  await capture('harness-updates-desktop');
  await page.click('[data-settings-section="machines"]');
  await page.waitFor(`document.getElementById('settings-machines').getBoundingClientRect().top < 150`);
  await page.click('[data-settings-section="updates"]');
  await page.waitFor(`document.getElementById('settings-updates').getBoundingClientRect().top > 0 && document.getElementById('settings-updates').getBoundingClientRect().top < 150`);

  await page.click(`${row(local, 'claude')} ${id('harness-update-skip')}`);
  await page.waitFor(`document.querySelector('${row(local, 'claude')} ${id('harness-update-unskip')}')`);
  expect(await page.evaluate(`document.querySelector('${row(remote, 'claude')} ${id('harness-update-row-run')}') !== null`)).toBe(true);
  await page.click(`${row(remote, 'codex')} ${id('harness-update-row-run')}`);
  await page.waitFor(`document.querySelector('${row(remote, 'codex')} .version')?.textContent === '0.155.1'`);
  expect(await page.evaluate(`document.querySelector('${row(local, 'codex')} ${id('harness-update-row-run')}') !== null`)).toBe(true);
  await page.click(`${remote} ${id('setting-auto-update-harnesses')}`);
  await page.waitFor(`document.querySelector('${remote} ${id('setting-auto-update-harnesses')}').checked`);
  expect(await page.evaluate(`document.querySelector('${local} ${id('setting-auto-update-harnesses')}').checked`)).toBe(false);

  const active = await page.evaluate('window.__boiteTest.workspace.active.machineId');
  for (const navigation of [id('settings-tab-machines'), '[data-settings-section="updates"]']) {
    await page.click('[data-settings-section="machines"]');
    await page.click(`${id('machine-card')}[data-machine-id="http://builder.test"] ${id('machine-settings-open')}`);
    await page.waitFor(`document.querySelector('${id('machine-settings')}')`);
    await page.click(navigation);
    await page.waitFor(`document.querySelector('${id('machines-page')}') && !document.querySelector('${id('machine-settings')}')`);
    expect(await page.evaluate('window.__boiteTest.workspace.active.machineId')).toBe(active);
  }
  await capture('harness-updates-from-machine-settings');

  await size(390);
  await page.waitFor(`document.querySelector('${id('machines-page')}')`);
  expect((await page.text('.mobile-settings > header h1')).trim()).toBe('Machines and updates');
  await page.evaluate(`document.querySelector('${local}').scrollIntoView({block:'start'})`);
  await capture('harness-updates-phone');
  await page.click(`${row(local, 'claude')} ${id('harness-update-unskip')}`);
  await page.waitFor(`document.querySelector('${row(local, 'claude')} ${id('harness-update-row-run')}')`);
  await page.click(`${row(local, 'codex')} ${id('harness-update-row-run')}`);
  await page.waitFor(`document.querySelector('${row(local, 'codex')} .version')?.textContent === '0.155.1'`);
}, 30_000);

test('unknown releases run their own updater and Providers keeps only installed versions', async () => {
  await machines();
  const cli = row(local, 'antigravity-cli');
  expect(await page.evaluate(`document.querySelector('${row(local, 'opencode')} .version').title`)).toContain('Up to date');
  expect(await page.evaluate(`document.querySelector('${cli} .version').title`)).toContain('Checks by itself');
  await page.click(`${cli} ${id('harness-update-row-blind')}`);
  await page.waitFor(`document.querySelector('${cli} ${id('harness-update-current')}')`);
  expect(await page.evaluate(`document.querySelector('${cli} ${id('harness-update-row-blind')}') === null`)).toBe(true);
  await capture('harness-update-blind-current');
  await page.click(id('settings-tab-accounts'));
  // Providers names no version: they are on Machines and updates, the page just left.
  await page.waitFor(`document.querySelector('${id('accounts-page')} ${id('provider-settings')}') !== null`);
  expect(await page.evaluate(`document.querySelectorAll('${id('accounts-page')} ${id('provider-update')}, ${id('accounts-page')} .version').length`)).toBe(0);
  for (const name of ['harness-updates-check', 'setting-auto-update-harnesses', 'harness-update-row-run', 'harness-update-row-blind', 'install-update']) {
    expect(await page.evaluate(`document.querySelector('${id('accounts-page')} ${id(name)}') === null`)).toBe(true);
  }
}, 30_000);
