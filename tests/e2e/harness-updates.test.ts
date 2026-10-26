import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
let url: string;
const id = (name: string) => `[data-testid="${name}"]`;
const LOCAL = 'local';
const BUILDER = 'http://builder.test';
// Providers shows one machine's agents at a time, the one its bar picked.
const card = id('harness-updates-card');
const row = (provider: string) => `${card} ${id('machine-agent-update')}[data-provider-id="${provider}"]`;
async function capture(name: string) {
  await page.evaluate('document.fonts.ready');
  await page.evaluate('Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.screenshot(join(process.env.BOITE_UPDATE_CAPTURES ?? join(import.meta.dir, '.artifacts'), `${name}.png`));
}
const size = (width: number) => page.send('Emulation.setDeviceMetricsOverride', { width, height: width < 720 ? 844 : 1000, deviceScaleFactor: 1, mobile: width < 720 });
async function settings(tab: string) {
  if (!await page.evaluate<boolean>(`document.querySelector('${id(`settings-tab-${tab}`)}') !== null`)) await page.click(id('nav-settings'));
  await page.waitFor(`document.querySelector('${id(`settings-tab-${tab}`)}')`);
  await page.click(id(`settings-tab-${tab}`));
}
async function machines() {
  await settings('machines');
  await page.waitFor(`document.querySelectorAll('${id('machine-updates-state')}').length === 2`);
}
async function providers() {
  await settings('accounts');
  await page.waitFor(`document.querySelector('${card}') && document.querySelector('${row('claude')}')`);
}
/** Picks the machine Providers changes in the bar above it; the window stays on its own machine. */
async function pick(machineId: string) {
  await page.click(id('settings-machine'));
  await page.waitFor(`document.querySelector('${id('settings-machine-menu')} [data-value="${machineId}"]')`);
  await page.click(`${id('settings-machine-menu')} [data-value="${machineId}"]`);
  await page.waitFor(`document.querySelector('${id('settings-machine-menu')}') === null && document.querySelector('${row('claude')}')`);
  await page.waitFor(`document.querySelector('${id('settings-machine')}').textContent.includes(${JSON.stringify(machineId === LOCAL ? 'This PC' : 'Builder')})`);
}
const agentState = (machineId: string, provider: string) => page.evaluate<string>(`JSON.stringify(window.__boiteTest.workspace.machines.find(machine => machine.id === ${JSON.stringify(machineId)}).store.harnessUpdates.find(update => update.providerId === ${JSON.stringify(provider)}))`);

beforeAll(async () => {
  const port = await freePort(); url = `http://127.0.0.1:${port}/?fake=1&updates=1&machines=1&open=recent`;
  server = await startUi(port);
}, 60_000);
beforeEach(async () => { page = await BrowserPage.launch({ url }); await size(1400); await page.waitFor(`document.querySelector('${id('nav-settings')}') && window.__boiteTest?.workspace.machines.length === 2`); }, 30_000);
afterEach(async () => { await page?.close(); }, 15_000);
afterAll(async () => { await server?.close(); }, 30_000);

test('agent updates live on Providers and Update and Skip target the machine its bar picked, on desktop and phone', async () => {
  expect(await page.evaluate(`document.querySelector('${id('harness-update-notices')}') === null`)).toBe(true);
  // Announced in the foot instead, bottom left.
  await page.waitFor(`document.querySelector('${id('nav-updates')}')`);
  await capture('harness-updates-chat');
  await machines();
  expect((await page.text(id('settings-tab-machines'))).trim()).toBe('Machines and updates');
  // Each machine's row says a release is waiting; the agents themselves are listed in the updates card, not under the rows.
  await page.waitFor(`document.querySelectorAll('${id('machine-updates-state')}[data-state="available"]').length === 2`);
  expect(await page.evaluate(`document.querySelector('${id('machines-page')} ${card}, ${id('machines-page')} ${id('machine-agent-update')}') === null`)).toBe(true);
  await page.waitFor(`document.querySelectorAll('${id('updates-other')}[data-part="codex"]').length === 2`);
  expect(await page.evaluate(`document.querySelectorAll('${id('updates-other')}[data-part="claude"]').length`)).toBe(2);
  await capture('harness-updates-machines');

  const active = await page.evaluate('window.__boiteTest.workspace.active.machineId');
  await providers();
  expect(await page.evaluate(`document.querySelector('${card} h2') !== null && document.querySelector('${card} h4') === null`)).toBe(true);
  // The window's machine is picked first.
  expect(await page.text(id('settings-machine'))).toContain('This PC');
  await capture('harness-updates-desktop');
  await page.click(`${row('claude')} ${id('harness-update-skip')}`);
  await page.waitFor(`document.querySelector('${row('claude')} ${id('harness-update-unskip')}')`);

  await pick(BUILDER);
  expect(await page.evaluate('window.__boiteTest.workspace.active.machineId')).toBe(active);
  expect(await page.evaluate(`document.querySelector('${row('claude')} ${id('harness-update-row-run')}') !== null`)).toBe(true);
  await page.click(`${row('codex')} ${id('harness-update-row-run')}`);
  await page.waitFor(`document.querySelector('${row('codex')} .version')?.textContent === '0.155.1'`);
  expect(await page.evaluate(`document.querySelector('${card} ${id('setting-auto-update-harnesses')}').checked`)).toBe(false);
  await page.click(`${card} ${id('setting-auto-update-harnesses')}`);
  await page.waitFor(`document.querySelector('${card} ${id('setting-auto-update-harnesses')}').checked`);
  await capture('harness-updates-remote');

  await pick(LOCAL);
  expect(await page.evaluate('window.__boiteTest.workspace.active.machineId')).toBe(active);
  expect(await page.evaluate(`document.querySelector('${row('codex')} ${id('harness-update-row-run')}') !== null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${row('claude')} ${id('harness-update-unskip')}') !== null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${card} ${id('setting-auto-update-harnesses')}').checked`)).toBe(false);
  await page.click(`${row('claude')} ${id('harness-update-unskip')}`);
  await page.waitFor(`document.querySelector('${row('claude')} ${id('harness-update-row-run')}')`);
  await page.click(`${row('claude')} ${id('harness-update-skip')}`);
  await page.waitFor(`document.querySelector('${row('claude')} ${id('harness-update-unskip')}')`);

  // A phone has no Providers page: Machines lists what each machine still offers, and Update starts it there.
  await size(390);
  await page.waitFor(`document.querySelector('${id('mobile-settings-connection')}') || document.querySelector('${id('machines-page')}')`);
  if (!await page.evaluate<boolean>(`document.querySelector('${id('machines-page')}') !== null`)) await page.click(id('mobile-settings-connection'));
  await page.waitFor(`document.querySelector('${id('machines-page')}') && document.querySelector('${id('updates-others')}')`);
  expect((await page.text('[data-testid=mobile-settings-header] h1')).trim()).toBe('Machines and updates');
  // Builder's codex is done and this PC's Claude is skipped: neither is offered again.
  expect(await page.evaluate(`document.querySelectorAll('${id('updates-other')}[data-part="codex"]').length`)).toBe(1);
  expect(await page.evaluate(`document.querySelectorAll('${id('updates-other')}[data-part="claude"]').length`)).toBe(1);
  expect(await page.text(`${id('updates-other')}[data-part="claude"]`)).toContain('Builder');
  await capture('harness-updates-phone');
  await page.click(id('updates-run-all'));
  await page.waitFor(`window.__boiteTest.workspace.machines.find(machine => machine.id === '${LOCAL}').store.harnessUpdates.find(update => update.providerId === 'codex')?.current === '0.155.1'`);
  expect(JSON.parse(await agentState(LOCAL, 'claude')).skipped).not.toBeNull();
  expect(JSON.parse(await agentState(BUILDER, 'claude')).current).toBe(JSON.parse(await agentState(BUILDER, 'claude')).latest);
}, 45_000);

test('unknown releases run their own updater and Machines keeps no agent versions', async () => {
  await providers();
  const cli = row('grok');
  expect(await page.evaluate(`document.querySelector('${row('opencode')} .version').title`)).toContain('Up to date');
  expect(await page.evaluate(`document.querySelector('${cli} .version').title`)).toContain('Checks by itself');
  await page.click(`${cli} ${id('harness-update-row-blind')}`);
  await page.waitFor(`document.querySelector('${cli} ${id('harness-update-current')}')`);
  expect(await page.evaluate(`document.querySelector('${cli} ${id('harness-update-row-blind')}') === null`)).toBe(true);
  await capture('harness-update-blind-current');
  // On Providers, a version is only ever in the agents card.
  expect(await page.evaluate(`[...document.querySelectorAll('${id('accounts-page')} ${id('provider-update')}')].every(node => node.closest('${card}'))`)).toBe(true);
  await settings('machines');
  // Machines names Boite's versions; the agents' are on Providers, the page just left.
  await page.waitFor(`document.querySelector('${id('machines-page')}') !== null`);
  for (const name of ['harness-updates-card', 'harness-updates-check', 'setting-auto-update-harnesses', 'harness-update-row-run', 'harness-update-row-blind', 'machine-agent-update', 'provider-update', 'install-update']) {
    expect(await page.evaluate(`document.querySelector('${id('machines-page')} ${id(name)}') === null`)).toBe(true);
  }
}, 30_000);

test('an update asked for while a turn of that agent runs says how many threads it waits for', async () => {
  // The open thread moves to Claude, then a permission card holds its tool call, the way a long command would.
  await page.waitFor(`document.querySelector('${id('composer-picker')}')`);
  await page.click(id('composer-picker'));
  const tile = `${id('composer-picker-menu')} [data-provider="claude"]`;
  await page.waitFor(`document.querySelector('${tile}') && !document.querySelector('${tile}').disabled`);
  await page.click(tile);
  const model = `${id('composer-picker-menu')} [data-model]:not([disabled])`;
  await page.waitFor(`document.querySelector('${model}') !== null`);
  await page.click(model);
  await page.waitFor(`document.querySelector('${id('composer-picker-menu')}') === null`);
  await page.type(id('composer-input'), 'Run the build [permission]');
  await page.waitFor(`!document.querySelector('${id('composer-send')}').disabled`);
  await page.click(id('composer-send'));
  await page.waitFor(`document.querySelector('${id('permission-card')}') !== null`);
  await providers();
  const claude = row('claude');
  await page.waitFor(`document.querySelector('${claude} ${id('harness-update-row-run')}') !== null`);
  await page.click(`${claude} ${id('harness-update-row-run')}`);
  const waiting = `document.querySelector('${claude} ${id('harness-update-progress')}')?.textContent === 'Waits for a thread to pause'`;
  await page.waitFor(waiting);
  await page.evaluate(`document.querySelector('${claude}').scrollIntoView({ block: 'center' })`);
  await capture('harness-update-waiting-desktop');
  // A phone has no Providers page: it reads the same wait in the updates button above its thread list.
  await size(390);
  await page.waitFor(`document.querySelector('${id('mobile-home')}')`);
  await page.click(id('mobile-home'));
  await page.waitFor(`document.querySelector('${id('nav-updates')}')`);
  await page.click(id('nav-updates'));
  const part = `[role=dialog]${id('updates-card')} ${id('updates-part')}[data-part="claude"]`;
  await page.waitFor(`[...document.querySelectorAll('${part}')].some(item => item.textContent.includes('Waits for a thread to pause'))`);
  await capture('harness-update-waiting-phone');
}, 30_000);
