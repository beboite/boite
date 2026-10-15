import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
let base: string;
const id = (name: string) => `[data-testid="${name}"]`;
const fixture = '/?fake=1&updates=1&open=recent&machines=1&appUpdate=available&serverUpdate=available';
const width = (value: number, height = 900) => page.send('Emulation.setDeviceMetricsOverride', { width: value, height, deviceScaleFactor: 1, mobile: value < 720 });
async function capture(name: string) {
  await page.evaluate('document.fonts.ready');
  await page.evaluate('Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.screenshot(join(process.env.BOITE_UPDATE_CAPTURES ?? join(import.meta.dir, '.artifacts'), `update-everything-${name}.png`));
}
/** What each row of the card says, machine by machine. */
function parts(): Promise<{ part: string; text: string }[]> {
  return page.evaluate<{ part: string; text: string }[]>(`[...document.querySelectorAll('${id('updates-part')}')].map(row => ({ part: row.dataset.part, text: row.textContent.replace(/\\s+/g, ' ').trim() }))`);
}

beforeAll(async () => { const port = await freePort(); base = `http://127.0.0.1:${port}`; server = await startUi(port); }, 90_000);
beforeEach(async () => {
  page = await BrowserPage.launch({ url: `${base}/?fake=1` });
  await width(1400);
  await page.evaluate(`localStorage.removeItem('boite.updates-later')`);
}, 30_000);
afterEach(async () => { await page?.close(); }, 15_000);
afterAll(async () => { await server?.close(); }, 30_000);

test('a release found opens the card bottom left at once, without downloading, and its close button puts it off until a newer one', async () => {
  await page.navigate(`${base}${fixture}`);
  await page.waitFor(`window.__boiteTest?.workspace.machines.length === 2 && document.querySelector('${id('updates-card')}')`);
  // Nothing was downloaded to make it appear: the app's release is offered as found.
  expect(await page.evaluate('window.__boiteTest.appUpdater?.snapshot.phase ?? null')).toBe('available');
  await page.waitFor(`document.querySelectorAll('${id('updates-part')}').length >= 5`);
  const rows = await parts();
  expect(rows.map((row) => row.part)).toEqual(expect.arrayContaining(['app', 'boite', 'claude', 'codex']));
  expect(rows.every((row) => !/Downloading|Updating/.test(row.text))).toBe(true);
  expect(await page.text(id('updates-card'))).toContain('then asks to restart');
  // Bottom left: the card's left edge on the sidebar's, its bottom just above the foot.
  await page.evaluate('Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))');
  const place = await page.evaluate<{ left: number; gap: number }>(`(() => {
    const card = document.querySelector('${id('updates-card')}').getBoundingClientRect();
    const rail = document.querySelector('${id('sidebar')}').getBoundingClientRect();
    const foot = document.querySelector('${id('sidebar')} .foot').getBoundingClientRect();
    return { left: Math.round(card.left - rail.left), gap: Math.round(foot.top - card.bottom) };
  })()`);
  expect(place.left).toBeLessThan(24);
  expect(place.gap).toBeGreaterThanOrEqual(0);
  expect(place.gap).toBeLessThan(16);
  expect(await page.evaluate(`document.querySelector('${id('nav-updates-dot')}') !== null`)).toBe(true);
  // Two buttons: this app alone, or everything.
  expect(await page.evaluate(`[...document.querySelectorAll('${id('updates-card')} footer button')].map(b => b.dataset.testid)`)).toEqual(['updates-app', 'updates-run']);
  expect((await page.text(id('updates-app'))).trim()).toBe('Update the app');
  expect((await page.text(id('updates-run'))).trim()).toBe('Update all');
  await capture('card-desktop');

  await page.click(id('updates-later'));
  await page.waitFor(`!document.querySelector('${id('updates-card')}') && !document.querySelector('${id('nav-updates-dot')}')`);
  expect(await page.evaluate(`document.querySelector('${id('nav-updates')}') !== null`)).toBe(true);
  // Put off for these releases, after a reload too; the button still opens it.
  await page.navigate(`${base}${fixture}`);
  await page.waitFor(`window.__boiteTest?.workspace.machines.length === 2 && document.querySelector('${id('nav-updates')}')`);
  await Bun.sleep(400);
  expect(await page.evaluate(`document.querySelector('${id('updates-card')}') === null && document.querySelector('${id('nav-updates-dot')}') === null`)).toBe(true);
  await page.click(id('nav-updates'));
  await page.waitFor(`document.querySelector('${id('updates-card')}')`);
}, 60_000);

test('Update all starts every machine at once, rows land one by one, and the card ends on Restart', async () => {
  await page.navigate(`${base}${fixture}`);
  await page.waitFor(`window.__boiteTest?.workspace.machines.length === 2 && document.querySelectorAll('${id('updates-part')}').length >= 5`);
  await page.evaluate(`window.__calls = []; for (const machine of window.__boiteTest.workspace.machines) {
    const client = machine.store.client; const call = client.call.bind(client);
    client.call = (method, params) => { if (method.startsWith('core.update') || method === 'providers.update') window.__calls.push([machine.label, method, params]); return call(method, params); };
  }`);
  await page.click(id('updates-run'));
  // Both machines asked in one request each: their agents and Boite together.
  await page.waitFor(`window.__calls.filter(([, method]) => method === 'core.updateEverything').length === 2`);
  const calls = await page.evaluate<[string, string, { agents: string[]; server: string | null }][]>('window.__calls');
  expect(calls.every(([, method]) => method === 'core.updateEverything')).toBe(true);
  // This computer's Boite comes with the app; the other machine installs its own.
  expect(Object.fromEntries(calls.map(([label, , params]) => [label, params]))).toEqual({
    'This PC': { agents: ['claude', 'codex'], server: null },
    Builder: { agents: ['claude', 'codex'], server: '2.0.0-beta.2' }
  });
  await page.waitFor(`[...document.querySelectorAll('${id('updates-part')}')].some(row => /Updating|Downloading|Waits/.test(row.textContent))`);
  // Downloaded while this computer's agents still update: the restart waits for them.
  await page.waitFor(`window.__boiteTest.appUpdater?.snapshot.phase === 'ready'`, 10_000);
  if (await page.evaluate(`[...document.querySelectorAll('${id('updates-part')}')].some(row => ['claude', 'codex'].includes(row.dataset.part) && !row.dataset.done && /Updating/.test(row.textContent))`)) {
    expect(await page.evaluate(`document.querySelector('${id('updates-restart')}').disabled`)).toBe(true);
  }
  await capture('running-desktop');
  // A part that lands keeps its row with a check for a moment, then the row goes.
  await page.waitFor(`document.querySelector('${id('updates-part')}[data-done]')?.textContent.includes('Up to date')`, 20_000);
  await capture('landing-desktop');
  await page.waitFor(`![...document.querySelectorAll('${id('updates-part')}')].some(row => ['claude', 'codex'].includes(row.dataset.part))`, 20_000);
  // Boite on the other machine restarts and lands too; what is left is this app, downloaded, and nothing restarted by itself.
  await page.waitFor(`[...document.querySelectorAll('${id('updates-part')}')].map(row => row.dataset.part).join() === 'app'`, 20_000);
  expect(await page.text(id('updates-status'))).toBe('Boite is ready: restart it to finish.');
  expect(await page.evaluate('window.__boiteTest.appUpdater?.snapshot.phase')).toBe('ready');
  await capture('restart-desktop');
  await page.click(id('updates-restart'));
  await page.waitFor(`window.__boiteTest.appUpdater?.snapshot.phase === 'installing'`, 10_000);
}, 90_000);

test('with no app release, the card ends on Everything is up to date and puts itself away', async () => {
  await page.navigate(`${base}/?fake=1&updates=1&open=recent&machines=1&serverUpdate=available`);
  await page.waitFor(`window.__boiteTest?.workspace.machines.length === 2 && document.querySelectorAll('${id('updates-part')}').length >= 4`);
  expect(await page.evaluate(`document.querySelector('${id('updates-app')}') === null`)).toBe(true);
  await page.click(id('updates-run'));
  await page.waitFor(`document.querySelector('${id('updates-status')}')?.textContent === 'Everything is up to date'`, 30_000);
  await capture('all-done-desktop');
  await page.waitFor(`!document.querySelector('${id('updates-card')}') && !document.querySelector('${id('nav-updates')}')`, 10_000);
}, 90_000);

test('Update the app downloads this app alone, asks no machine for anything, then offers Restart', async () => {
  await page.navigate(`${base}${fixture}`);
  await page.waitFor(`window.__boiteTest?.workspace.machines.length === 2 && document.querySelectorAll('${id('updates-part')}').length >= 5`);
  await page.evaluate(`window.__calls = []; for (const machine of window.__boiteTest.workspace.machines) {
    const client = machine.store.client; const call = client.call.bind(client);
    client.call = (method, params) => { if (method.startsWith('core.update') || method === 'providers.update') window.__calls.push([machine.label, method]); return call(method, params); };
  }`);
  await page.click(id('updates-app'));
  await page.waitFor(`document.querySelector('${id('updates-restart')}')`, 20_000);
  expect(await page.evaluate('window.__boiteTest.appUpdater?.snapshot.phase')).toBe('ready');
  expect(await page.evaluate('window.__calls')).toEqual([]);
  // The agents and the other machine are still offered.
  expect((await parts()).filter((row) => row.part !== 'app').every((row) => !/Updating|Downloading/.test(row.text))).toBe(true);
  await page.click(id('updates-restart'));
  await page.waitFor(`window.__boiteTest.appUpdater?.snapshot.phase === 'installing'`, 10_000);
}, 60_000);

test('the phone keeps the card closed until asked and opens it as a sheet', async () => {
  await width(390, 844);
  await page.navigate(`${base}${fixture}`);
  await page.waitFor(`window.__boiteTest?.workspace.machines.length === 2`);
  await page.evaluate(`window.__boiteTest.workspace.active.sidebarOpen = true`);
  await page.waitFor(`document.querySelector('${id('nav-updates')}')?.getClientRects().length > 0`);
  await Bun.sleep(400);
  expect(await page.evaluate(`document.querySelector('${id('updates-card')}') === null`)).toBe(true);
  await page.click(id('nav-updates'));
  await page.waitFor(`document.querySelectorAll('${id('updates-part')}').length >= 5`);
  await capture('card-phone');
}, 60_000);
